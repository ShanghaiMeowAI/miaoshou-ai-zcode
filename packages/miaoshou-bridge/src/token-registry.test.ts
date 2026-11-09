import { describe, expect, it, beforeEach } from "vitest";
import {
  rememberUserToken,
  getUserToken,
  clearUserTokens,
} from "./token-registry.js";

describe("token-registry", () => {
  beforeEach(() => {
    clearUserTokens();
  });

  it("正常记录并获取用户的最新 token", () => {
    rememberUserToken(101, "Bearer token-1");
    const entry = getUserToken(101);
    expect(entry?.token).toBe("Bearer token-1");
    expect(typeof entry?.updatedAt).toBe("number");
  });

  it("后来的 token 会覆盖旧 token", () => {
    rememberUserToken(101, "Bearer old");
    rememberUserToken(101, "Bearer new");
    expect(getUserToken(101)?.token).toBe("Bearer new");
  });

  it("非法用户编号与空白 token 被忽略", () => {
    rememberUserToken(0, "Bearer token");
    rememberUserToken(-1, "Bearer token");
    rememberUserToken(NaN, "Bearer token");
    rememberUserToken(102, "   ");
    expect(getUserToken(0)).toBeUndefined();
    expect(getUserToken(-1)).toBeUndefined();
    expect(getUserToken(102)).toBeUndefined();
  });

  it("超过 TTL 的 token 自动失效", () => {
    rememberUserToken(101, "Bearer token-1");
    const future = Date.now() + 25 * 60 * 60 * 1000;
    expect(getUserToken(101, future)).toBeUndefined();
  });
});
