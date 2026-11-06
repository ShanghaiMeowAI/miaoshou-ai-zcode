/**
 * /goal 命令面：对齐 zcode 原生命令中心的做法——命令在"客户端"本地解析并
 * 执行，不进模型；只有创建/恢复目标后的续跑才动用模型。goal 状态持久在
 * 平台侧（api-agent 的 agent_goals 表与既有 HTTP 接口），本模块只做解析、
 * 调用与回执格式化。
 */
import { internalBaseUrl } from "./bridge-internal-client.js";

export type GoalCommandKind =
  | "status"
  | "list"
  | "new"
  | "set"
  | "use"
  | "criteria"
  | "plan"
  | "plan_add"
  | "plan_next"
  | "plan_task"
  | "step"
  | "summary"
  | "log"
  | "log_query"
  | "blocker_resolve"
  | "pause"
  | "resume"
  | "done"
  | "clear"
  | "verify"
  | "help";

export interface GoalCommand {
  kind: GoalCommandKind;
  /** 命令参数：目标描述 / 条目文本 / Goal 编号等（无参命令缺省） */
  text?: string;
  /** plan_task 的目标条目编号（1 起） */
  taskIndex?: number;
  /** log 记录类型（kind === "log" 时有效） */
  logKind?: "note" | "decision" | "constraint" | "assumption" | "evidence" | "blocker";
  /** log_query 查询的记录类型 */
  queryKind?: string;
}

export interface GoalCommandOutcome {
  /** 本地回执文本（流式下发并落库为助手消息） */
  reply: string;
  /** goal 状态变化时下发的 goal 事件（前端据此更新目标卡片） */
  goalEvent?: { type: "goal"; goal: Record<string, unknown> };
  /** 创建/恢复类命令：回执之后附带 goal 上下文的续跑提示词 */
  continuationPrompt?: string;
  /** 执行失败（回执里带错误说明，对话不中断） */
  failed?: boolean;
}

interface GoalRecord {
  id?: number;
  revision?: number;
  objective?: string;
  status?: string;
  acceptance_criteria?: string[];
  plan?: Array<Record<string, unknown>>;
  current_step?: string | null;
  context_summary?: string | null;
  blocked_reason?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  rounds_started?: number;
  max_rounds?: number;
}

/** 会触发模型续跑的命令：这类命令照常过配额闸门。 */
const GOAL_COMMANDS_USING_MODEL = new Set<GoalCommandKind>(["new", "use", "resume"]);

export function goalCommandUsesModel(command: GoalCommand): boolean {
  return GOAL_COMMANDS_USING_MODEL.has(command.kind);
}

const LOG_KIND_ALIASES: Array<[RegExp, GoalCommand["logKind"]]> = [
  [/^(?:goal\s+)?(?:note|remember|memo|记录)$/, "note"],
  [/^(?:goal\s+)?(?:decision|decide|why|决策|决定)$/, "decision"],
  [/^(?:goal\s+)?(?:constraint|requirement|rule|约束|要求)$/, "constraint"],
  [/^(?:goal\s+)?(?:assumption|assume|假设)$/, "assumption"],
  [/^(?:goal\s+)?(?:evidence|proof|verified|证据)$/, "evidence"],
  [/^(?:goal\s+)?(?:blocker|问题)$/, "blocker"],
];

const LOG_QUERY_KINDS = new Set([
  "note",
  "notes",
  "decision",
  "decisions",
  "constraint",
  "constraints",
  "assumption",
  "assumptions",
  "evidence",
  "blocker",
  "blockers",
]);

function normalizeQueryKind(raw: string): string {
  const singular: Record<string, string> = {
    notes: "note",
    decisions: "decision",
    constraints: "constraint",
    assumptions: "assumption",
    blockers: "blocker",
  };
  return singular[raw] ?? raw;
}

/**
 * 解析 /goal 系命令。返回 undefined 表示不是目标命令（照常进模型）。
 * 未知子命令视为目标描述（与 zcode 一致：/goal <objective> 即创建）。
 */
export function parseGoalCommand(message: string): GoalCommand | undefined {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1).trim();
  const isGoalFamily = body.startsWith("goal") || body === "goals" || body.startsWith("goals ");
  if (!isGoalFamily && !/^(?:note|remember|memo|记录|criteria|acceptance|accept|验收条件|标准|checkpoint|step|current-step|当前步骤|检查点|next|add-task|pause|resume|reopen|done|clear-goal|audit-goal|ready|verify|decision|decide|why|决策|决定|constraint|requirement|rule|约束|要求|assumption|assume|假设|evidence|proof|verified|证据|blocker|blockers|issues|问题|resolve-blocker|unblock|解决阻塞|解除阻塞)(?:\s|$)/.test(body)) {
    return undefined;
  }

  // /goal 系：剥掉 goal 前缀后按子命令分派
  if (isGoalFamily) {
    if (body === "goals") return { kind: "list" };
    let rest = body.replace(/^goals?\b/, "").trim();
    if (!rest) return { kind: "status" };
    const [head, ...tail] = rest.split(/\s+/);
    const tailText = tail.join(" ").trim();
    const headLower = (head ?? "").toLowerCase();
    if (headLower === "status") return { kind: "status" };
    if (headLower === "list") return { kind: "list" };
    if (headLower === "help" || headLower === "commands") return { kind: "help" };
    if (headLower === "new") return { kind: "new", text: tailText };
    if (headLower === "set" || headLower === "replace") return { kind: "set", text: tailText };
    if (headLower === "use" || headLower === "reopen") return { kind: "use", text: tailText };
    if (headLower === "criteria") return { kind: "criteria", text: tailText };
    if (headLower === "plan" && tailText) return { kind: "plan", text: tailText };
    if (headLower === "add") return { kind: "plan_add", text: tailText };
    if (headLower === "next") return { kind: "plan_next" };
    if (headLower === "task") {
      const taskIndex = Number(tail[0]);
      const taskRest = tail.slice(1).join(" ").trim();
      return {
        kind: "plan_task",
        text: taskRest,
        taskIndex: Number.isInteger(taskIndex) && taskIndex > 0 ? taskIndex : undefined,
      };
    }
    if (headLower === "step") return { kind: "step", text: tailText };
    if (headLower === "summary") return { kind: "summary", text: tailText };
    if (headLower === "pause") return { kind: "pause" };
    if (headLower === "resume") return { kind: "resume" };
    if (headLower === "done" || headLower === "complete") return { kind: "done" };
    if (headLower === "clear" || headLower === "cancel") return { kind: "clear" };
    if (headLower === "verify" || headLower === "ready" || headLower === "audit") {
      return { kind: "verify", text: "" };
    }
    if (headLower === "resolve-blocker" || headLower === "unblock") {
      return { kind: "blocker_resolve", text: tailText };
    }
    for (const [pattern, logKind] of LOG_KIND_ALIASES) {
      if (pattern.test(headLower) || pattern.test(`goal ${headLower}`)) {
        return { kind: "log", logKind, text: tailText };
      }
    }
    if (LOG_QUERY_KINDS.has(headLower)) {
      return { kind: "log_query", text: "", queryKind: normalizeQueryKind(headLower) };
    }
    // 未知子命令：整段视为目标描述（/goal <objective> 创建）
    return { kind: "new", text: rest };
  }

  // /goals 短命令（无 goal 前缀）
  if (body === "goals") return { kind: "list" };

  // 其余短命令别名
  const [head, ...tail] = body.split(/\s+/);
  const tailText = tail.join(" ").trim();
  const headLower = (head ?? "").toLowerCase();
  if (headLower === "pause") return { kind: "pause" };
  if (headLower === "resume") return { kind: "resume" };
  if (headLower === "reopen") return { kind: "use", text: tailText };
  if (headLower === "done") return { kind: "done" };
  if (headLower === "clear-goal") return { kind: "clear" };
  if (headLower === "next") return { kind: "plan_next" };
  if (headLower === "add-task") return { kind: "plan_add", text: tailText };
  if (headLower === "criteria" || head === "验收条件" || head === "标准") {
    return { kind: "criteria", text: tailText };
  }
  if (
    headLower === "checkpoint" ||
    headLower === "current-step" ||
    head === "当前步骤" ||
    head === "检查点" ||
    headLower === "step"
  ) {
    return { kind: "step", text: tailText };
  }
  if (headLower === "verify" || headLower === "ready" || headLower === "audit-goal") {
    return { kind: "verify" };
  }
  if (headLower === "resolve-blocker" || headLower === "unblock" || head === "解决阻塞" || head === "解除阻塞") {
    return { kind: "blocker_resolve", text: tailText };
  }
  for (const [pattern, logKind] of LOG_KIND_ALIASES) {
    if (pattern.test(headLower)) {
      return { kind: "log", logKind, text: tailText };
    }
  }
  if (LOG_QUERY_KINDS.has(headLower)) {
    return { kind: "log_query", text: "", queryKind: normalizeQueryKind(headLower) };
  }
  return undefined;
}

// ── 平台 HTTP 调用 ─────────────────────────────────────────────────────

interface AgentApiResponse {
  data?: Record<string, unknown>;
  error?: string;
}

async function agentApiRequest(
  method: "GET" | "POST" | "PATCH",
  path: string,
  userId: string,
  body?: unknown,
): Promise<AgentApiResponse> {
  try {
    const response = await fetch(`${internalBaseUrl()}${path}`, {
      method,
      signal: AbortSignal.timeout(8000),
      headers: {
        "content-type": "application/json",
        "X-User-ID": userId,
        "X-User-Role": "user",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await response.json().catch(() => undefined)) as
      | { data?: Record<string, unknown>; detail?: unknown }
      | undefined;
    if (!response.ok) {
      const detail = json?.detail;
      return { error: typeof detail === "string" ? detail : `HTTP ${response.status}` };
    }
    return { data: json?.data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchGoal(
  conversationId: number,
  userId: string,
): Promise<{ goal?: GoalRecord; error?: string }> {
  const result = await agentApiRequest(
    "GET",
    `/api/agent/conversations/${conversationId}/goal`,
    userId,
  );
  if (result.error) return { error: result.error };
  const goal = result.data?.goal as GoalRecord | null | undefined;
  return goal ? { goal } : {};
}

function goalEventOf(goal: GoalRecord): GoalCommandOutcome["goalEvent"] {
  return { type: "goal", goal: goal as Record<string, unknown> };
}

// ── 回执格式化 ─────────────────────────────────────────────────────────

const GOAL_STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  complete: "已完成",
  completed: "已完成",
  cancelled: "已取消",
};

function formatGoal(goal: GoalRecord): string {
  const status = GOAL_STATUS_LABEL[String(goal.status)] || String(goal.status);
  const lines = [`Goal #${goal.id} · ${status}`, `目标：${goal.objective}`];
  if (goal.current_step) lines.push(`当前步骤：${goal.current_step}`);
  if (goal.context_summary) lines.push(`上下文摘要：${goal.context_summary}`);
  if (goal.acceptance_criteria?.length) {
    lines.push("验收条件：");
    lines.push(...goal.acceptance_criteria.map((item) => `- ${item}`));
  }
  const plan = goal.plan ?? [];
  if (plan.length > 0) {
    lines.push("计划：");
    plan.forEach((item, index) => {
      const content = String(item.content ?? item.step ?? "");
      const itemStatus = String(item.status ?? "pending");
      lines.push(`- #${index + 1} [${itemStatus}] ${content}`);
    });
  }
  const metadata = goal.metadata ?? {};
  const blockers = (metadata.blockers as Array<Record<string, unknown>> | undefined) ?? [];
  const openBlockers = blockers.filter((item) => !item.resolved);
  if (openBlockers.length > 0) {
    lines.push(`未解决阻塞：${openBlockers.length} 项（/goal blocker 查看）`);
  }
  if (goal.blocked_reason) {
    const reason = goal.blocked_reason as { message?: string };
    lines.push(`阻塞原因：${reason.message ?? ""}`);
  }
  lines.push(`轮数：${goal.rounds_started ?? 0}/${goal.max_rounds ?? 0}`);
  return lines.join("\n");
}

function goalContextPrompt(goal: GoalRecord): string {
  const lines = [
    "用户通过 /goal 命令建立/恢复了持续目标，目标详情：",
    `目标：${goal.objective}`,
  ];
  if (goal.acceptance_criteria?.length) {
    lines.push(`验收条件：${goal.acceptance_criteria.join("；")}`);
  }
  const plan = goal.plan ?? [];
  if (plan.length > 0) {
    lines.push(`计划：${plan.map((item) => String(item.content ?? item.step ?? "")).join("；")}`);
  }
  if (goal.current_step) lines.push(`当前步骤：${goal.current_step}`);
  lines.push("请围绕该目标推进下一步工作：结合平台量化工具执行可落地的动作，完成后说明进展与下一步。");
  return lines.join("\n");
}

function splitSemicolon(text: string): string[] {
  return text
    .split(/[;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function noGoalReply(): string {
  return "当前会话没有进行中的 Goal。用 /goal <目标描述> 创建，或 /goal list 查看历史目标。";
}

// ── 执行器 ─────────────────────────────────────────────────────────────

function planWithStatus(text: string): Array<Record<string, unknown>> {
  return splitSemicolon(text).map((content) => ({ content, status: "pending" }));
}

async function patchGoal(
  conversationId: number,
  userId: string,
  goal: GoalRecord,
  patchBody: Record<string, unknown>,
): Promise<AgentApiResponse> {
  return agentApiRequest(
    "PATCH",
    `/api/agent/conversations/${conversationId}/goals/${goal.id}`,
    userId,
    { revision: goal.revision, ...patchBody },
  );
}

function updatedGoalFrom(result: AgentApiResponse): GoalRecord | undefined {
  return result.data?.goal as GoalRecord | undefined;
}

export async function executeGoalCommand(params: {
  command: GoalCommand;
  conversationId: number;
  userId: string;
}): Promise<GoalCommandOutcome> {
  const { command, conversationId, userId } = params;
  const goalResult = await fetchGoal(conversationId, userId);
  const goal = goalResult.goal;

  switch (command.kind) {
    case "status":
      if (goalResult.error) {
        return { reply: `查询目标失败：${goalResult.error}`, failed: true };
      }
      return { reply: goal ? formatGoal(goal) : noGoalReply() };

    case "list": {
      const result = await agentApiRequest(
        "GET",
        `/api/agent/conversations/${conversationId}/goals`,
        userId,
      );
      if (result.error) return { reply: `查询目标列表失败：${result.error}`, failed: true };
      const items = (result.data?.items as GoalRecord[] | undefined) ?? [];
      if (items.length === 0) return { reply: noGoalReply() };
      const lines = items.map((item) => {
        const status = GOAL_STATUS_LABEL[String(item.status)] || String(item.status);
        return `- #${item.id} [${status}] ${item.objective}`;
      });
      return { reply: `本会话的 Goal（共 ${items.length} 个）：\n${lines.join("\n")}` };
    }

    case "help":
      return {
        reply: [
          "Goal 命令帮助：",
          "- /goal <目标描述>：创建持续目标（创建后会自动围绕目标推进）",
          "- /goal status：查看当前目标；/goal list：查看全部目标",
          "- /goal set <描述>：更新目标；/goal criteria <条件;条件>：设置验收条件",
          "- /goal plan <步骤;步骤>：设置计划；/goal add <步骤>：追加；/goal next：推进计划",
          "- /goal task <n> [done|edit <描述>]：查看或更新计划项",
          "- /goal step <文本> / /goal summary <文本>：记录当前步骤 / 上下文摘要",
          "- /goal note|decision|constraint|assumption|evidence|blocker <文本>：记录目标日志",
          "- /goal pause / resume / done / clear：暂停 / 恢复 / 完成 / 取消目标",
          "- /goal use <编号>：切换/重新打开目标；/goal verify：完成前检查",
        ].join("\n"),
      };

    case "new": {
      if (!command.text) {
        return { reply: "用法：/goal <目标描述>", failed: true };
      }
      if (goal) {
        return {
          reply: `已有进行中的 Goal #${goal.id}（${goal.objective}）。请先用 /goal done 或 /goal clear 处理，或用 /goal set 更新目标。`,
          failed: true,
        };
      }
      const result = await agentApiRequest(
        "POST",
        `/api/agent/conversations/${conversationId}/goals`,
        userId,
        { objective: command.text },
      );
      if (result.error) return { reply: `创建 Goal 失败：${result.error}`, failed: true };
      const created = updatedGoalFrom(result);
      return {
        reply: `Goal 已创建，开始围绕目标推进：\n${created ? formatGoal(created) : command.text}`,
        goalEvent: created ? goalEventOf(created) : undefined,
        continuationPrompt: created ? goalContextPrompt(created) : undefined,
      };
    }

    case "set": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      if (!command.text) return { reply: "用法：/goal set <新目标描述>", failed: true };
      const result = await patchGoal(conversationId, userId, goal, { objective: command.text });
      if (result.error) return { reply: `更新目标失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: `目标已更新：${command.text}`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "use": {
      const targetId = Number(command.text);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return { reply: "用法：/goal use <Goal 编号>（先用 /goal list 查看）", failed: true };
      }
      const listResult = await agentApiRequest(
        "GET",
        `/api/agent/conversations/${conversationId}/goals`,
        userId,
      );
      if (listResult.error) return { reply: `查询目标失败：${listResult.error}`, failed: true };
      const items = (listResult.data?.items as GoalRecord[] | undefined) ?? [];
      const target = items.find((item) => item.id === targetId);
      if (!target) return { reply: `没有找到 Goal #${targetId}`, failed: true };
      if (target.status === "active") {
        return { reply: `Goal #${targetId} 已是进行中：\n${formatGoal(target)}` };
      }
      const result = await patchGoal(conversationId, userId, target, { status: "active" });
      if (result.error) {
        return {
          reply: `恢复 Goal #${targetId} 失败：${result.error}（已完成/已取消的目标不能恢复）`,
          failed: true,
        };
      }
      const updated = updatedGoalFrom(result);
      return {
        reply: `Goal #${targetId} 已恢复为进行中：\n${updated ? formatGoal(updated) : ""}`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
        continuationPrompt: updated ? goalContextPrompt(updated) : undefined,
      };
    }

    case "criteria": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      const items = splitSemicolon(command.text ?? "");
      if (items.length === 0) {
        return { reply: "用法：/goal criteria <条件1;条件2>（分号分隔）", failed: true };
      }
      const result = await patchGoal(conversationId, userId, goal, {
        acceptance_criteria: items,
      });
      if (result.error) return { reply: `设置验收条件失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: `验收条件已设置（${items.length} 条）：\n${items.map((item) => `- ${item}`).join("\n")}`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "plan": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      const plan = planWithStatus(command.text ?? "");
      if (plan.length === 0) return { reply: "用法：/goal plan <步骤1;步骤2>", failed: true };
      const result = await patchGoal(conversationId, userId, goal, { plan });
      if (result.error) return { reply: `设置计划失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: `计划已设置（${plan.length} 步）：\n${plan.map((item, i) => `- #${i + 1} ${item.content}`).join("\n")}`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "plan_add": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      if (!command.text) return { reply: "用法：/goal add <步骤描述>", failed: true };
      const plan = [...(goal.plan ?? []), { content: command.text, status: "pending" }];
      const result = await patchGoal(conversationId, userId, goal, { plan });
      if (result.error) return { reply: `追加计划失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: `计划已追加：${command.text}（当前共 ${plan.length} 步）`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "plan_next": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      const plan = goal.plan ?? [];
      const index = plan.findIndex((item) => String(item.status ?? "pending") === "pending");
      if (index < 0) return { reply: "计划没有待办步骤了，可用 /goal add 追加或 /goal done 完成目标。" };
      plan[index] = { ...plan[index], status: "done" };
      const nextItem = plan[index + 1];
      const patchBody: Record<string, unknown> = { plan };
      if (nextItem) patchBody.current_step = String(nextItem.content ?? nextItem.step ?? "");
      const result = await patchGoal(conversationId, userId, goal, patchBody);
      if (result.error) return { reply: `推进计划失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: `步骤 #${index + 1} 已完成${nextItem ? `，当前步骤切到：${String(nextItem.content ?? nextItem.step ?? "")}` : "（计划已全部完成）"}`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "plan_task": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      const plan = goal.plan ?? [];
      if (command.taskIndex === undefined) {
        if (plan.length === 0) return { reply: "当前目标没有计划。用 /goal plan <步骤;步骤> 设置。" };
        return {
          reply: `计划（共 ${plan.length} 步）：\n${plan
            .map((item, i) => `- #${i + 1} [${String(item.status ?? "pending")}] ${String(item.content ?? item.step ?? "")}`)
            .join("\n")}\n更新：/goal task <n> done 或 /goal task <n> edit <新描述>`,
        };
      }
      const idx = command.taskIndex - 1;
      if (idx < 0 || idx >= plan.length) {
        return { reply: `没有计划项 #${command.taskIndex}（共 ${plan.length} 步）`, failed: true };
      }
      if (!command.text) {
        const item = plan[idx];
        if (item) {
          return {
            reply: `计划项 #${command.taskIndex}：[${String(item.status ?? "pending")}] ${String(item.content ?? item.step ?? "")}`,
          };
        }
      }
      let patchBody: Record<string, unknown> | undefined;
      if (command.text === "done" || command.text === "完成") {
        plan[idx] = { ...plan[idx], status: "done" };
        patchBody = { plan };
      } else if ((command.text ?? "").startsWith("edit ")) {
        plan[idx] = { ...plan[idx], content: (command.text ?? "").slice(5).trim() };
        patchBody = { plan };
      } else {
        return { reply: "用法：/goal task <n> done 或 /goal task <n> edit <新描述>", failed: true };
      }
      const result = await patchGoal(conversationId, userId, goal, patchBody);
      if (result.error) return { reply: `更新计划项失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: `计划项 #${command.taskIndex} 已更新`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "step": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      if (!command.text) return { reply: `当前步骤：${goal.current_step ?? "（未设置）"}` };
      const result = await patchGoal(conversationId, userId, goal, {
        current_step: command.text,
      });
      if (result.error) return { reply: `记录步骤失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: `当前步骤已记录：${command.text}`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "summary": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      if (!command.text) return { reply: `上下文摘要：${goal.context_summary ?? "（未设置）"}` };
      const result = await patchGoal(conversationId, userId, goal, {
        context_summary: command.text,
      });
      if (result.error) return { reply: `记录摘要失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: "上下文摘要已记录。",
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "log": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      if (!command.logKind || !command.text) {
        return { reply: "用法：/goal note|decision|constraint|assumption|evidence|blocker <内容>", failed: true };
      }
      const result = await patchGoal(conversationId, userId, goal, {
        log: { kind: command.logKind, content: command.text },
      });
      if (result.error) return { reply: `记录失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      const label: Record<string, string> = {
        note: "备注",
        decision: "决策",
        constraint: "约束",
        assumption: "假设",
        evidence: "验证证据",
        blocker: "阻塞项",
      };
      return {
        reply: `${label[command.logKind] ?? "记录"}已记录：${command.text}`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "log_query": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      const metadata = goal.metadata ?? {};
      const logs = (metadata.logs as Array<Record<string, unknown>> | undefined) ?? [];
      const wanted = command.queryKind;
      const matched = logs.filter((item) => {
        const kind = String(item.kind ?? "");
        if (wanted === "blocker") return kind === "blocker" || kind === "blocker_resolved";
        return kind === wanted;
      });
      const label: Record<string, string> = {
        note: "备注",
        decision: "决策",
        constraint: "约束",
        assumption: "假设",
        evidence: "证据",
        blocker: "阻塞",
      };
      if (matched.length === 0) {
        return { reply: `当前 Goal 还没有${label[wanted ?? ""] ?? ""}记录。` };
      }
      return {
        reply: `${label[wanted ?? ""] ?? "记录"}（${matched.length} 条）：\n${matched
          .map((item) => {
            const kind = String(item.kind ?? "");
            const mark = kind === "blocker_resolved" ? "（已解决）" : "";
            return `- ${String(item.content ?? "")}${mark}`;
          })
          .join("\n")}`,
      };
    }

    case "blocker_resolve": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      if (!command.text) return { reply: "用法：/goal resolve-blocker <编号或内容片段>", failed: true };
      const result = await patchGoal(conversationId, userId, goal, {
        log: { kind: "blocker_resolved", content: command.text, target: command.text },
      });
      if (result.error) return { reply: `解决阻塞失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      return {
        reply: "阻塞项已标记解决。",
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
    }

    case "pause":
    case "resume":
    case "done":
    case "clear": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      const statusByKind: Record<string, string> = {
        pause: "paused",
        resume: "active",
        done: "complete",
        clear: "cancelled",
      };
      const labelByKind: Record<string, string> = {
        pause: "已暂停",
        resume: "已恢复为进行中",
        done: "已完成",
        clear: "已取消",
      };
      const result = await patchGoal(conversationId, userId, goal, {
        status: statusByKind[command.kind],
      });
      if (result.error) return { reply: `操作失败：${result.error}`, failed: true };
      const updated = updatedGoalFrom(result);
      const outcome: GoalCommandOutcome = {
        reply: `Goal #${goal.id} ${labelByKind[command.kind]}。`,
        goalEvent: updated ? goalEventOf(updated) : undefined,
      };
      if (command.kind === "resume" && updated) {
        outcome.continuationPrompt = goalContextPrompt(updated);
      }
      return outcome;
    }

    case "verify": {
      if (!goal) return { reply: noGoalReply(), failed: true };
      const lines = [`Goal #${goal.id} 完成前检查：`];
      const criteria = goal.acceptance_criteria ?? [];
      lines.push(`- 验收条件：${criteria.length} 条${criteria.length ? "" : "（未设置，建议 /goal criteria 补充）"}`);
      const plan = goal.plan ?? [];
      const pendingCount = plan.filter((item) => String(item.status ?? "pending") === "pending").length;
      lines.push(`- 计划：${plan.length} 步，待办 ${pendingCount} 步`);
      const metadata = goal.metadata ?? {};
      const blockers = (metadata.blockers as Array<Record<string, unknown>> | undefined) ?? [];
      const openBlockers = blockers.filter((item) => !item.resolved);
      lines.push(`- 未解决阻塞：${openBlockers.length} 项`);
      const evidence = (metadata.evidence as unknown[] | undefined) ?? [];
      lines.push(`- 验证证据：${evidence.length} 条`);
      const ready = criteria.length > 0 && pendingCount === 0 && openBlockers.length === 0;
      lines.push(ready ? "结论：满足完成条件，可执行 /goal done。" : "结论：还有未完成项，暂不建议 /goal done。");
      return { reply: lines.join("\n") };
    }
  }
}
