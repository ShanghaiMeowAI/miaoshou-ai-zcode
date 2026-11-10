/**
 * 量化工具标题缓存：通过 MCP 标准 tools/list 从工具所有者（quant MCP）拉取。
 * 中文标题的唯一事实源是 api-agent 的 @tool(title=...) 声明，本模块只做
 * 运行时搬运，不维护任何本地字典。
 *
 * tools/list 受 quant 中间件的身份校验约束（X-User-ID 必须是数字），
 * 因此预热由携带用户身份的聊天流触发；quant FastMCP 配置为
 * stateless_http + json_response，单次 POST 即达，无需握手与会话头。
 */
import { trustedQuantUrl } from "./index.js";

const REQUEST_TIMEOUT_MS = 3_000;

interface JsonRpcTool {
  name?: unknown;
  title?: unknown;
}

let titleCache: Map<string, string> | null = null;
let loadInFlight: Promise<void> | null = null;
let lastSeenUserId: string | undefined;

async function fetchToolTitles(userId: string): Promise<Map<string, string>> {
  const secret =
    process.env.QUANT_MCP_INTERNAL_SECRET ||
    process.env.MIAOSHOU_QUANT_INTERNAL_SECRET ||
    "";
  const response = await fetch(trustedQuantUrl(), {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-User-ID": userId,
      ...(secret ? { "X-Internal-Secret": secret } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (!response.ok) throw new Error(`tools/list HTTP ${response.status}`);
  const body = (await response.json()) as { result?: { tools?: JsonRpcTool[] } };
  const tools = body?.result?.tools;
  if (!Array.isArray(tools)) throw new Error("tools/list 未返回工具数组");
  const next = new Map<string, string>();
  for (const tool of tools) {
    if (typeof tool?.name === "string" && typeof tool?.title === "string" && tool.title) {
      next.set(tool.name, tool.title);
    }
  }
  return next;
}

function startLoad(userId: string): void {
  if (loadInFlight) return;
  loadInFlight = fetchToolTitles(userId)
    .then((titles) => {
      titleCache = titles;
    })
    .catch((error: unknown) => {
      // quant MCP 暂不可达只影响状态行文案的具体程度（前端显示通用文案），
      // 不影响工具执行链路；下一次流启动或标题未命中时会再次尝试
      console.warn(`[miaoshou-bridge] 拉取量化工具标题失败: ${String(error)}`);
    })
    .finally(() => {
      loadInFlight = null;
    });
}

/** 聊天流启动时预热：仅在缓存为空时拉取（标题随部署静态，无需每流刷新）。 */
export function primeQuantToolTitles(userId: string): void {
  lastSeenUserId = userId;
  if (titleCache === null) startLoad(userId);
}

/** 同步读取标题；未命中时用最近身份触发一次去重刷新（覆盖滚动升级窗口）。 */
export function getQuantToolTitle(toolName: string): string | undefined {
  const title = titleCache?.get(toolName);
  if (title === undefined && lastSeenUserId) startLoad(lastSeenUserId);
  return title;
}

/** 测试钩子：重置模块状态。 */
export function resetQuantToolTitlesForTests(): void {
  titleCache = null;
  loadInFlight = null;
  lastSeenUserId = undefined;
}
