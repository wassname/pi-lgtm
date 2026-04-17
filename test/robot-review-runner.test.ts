import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROBOT_REVIEW_TIMEOUT_MS,
  extractFinalAssistantTextFromPiJsonl,
  getPiInvocation,
  getRobotReviewTimeoutMs,
  runRobotReviewCommand,
} from "../src/index.js";

describe("robot review runner helpers", () => {
  it("uses plain pi by default and allows override", () => {
    expect(getPiInvocation(["--mode", "json"], {} as NodeJS.ProcessEnv)).toEqual({
      command: "pi",
      args: ["--mode", "json"],
    });
    expect(getPiInvocation(["-p"], { PI_LGTM_PI_BIN: "/custom/pi" } as NodeJS.ProcessEnv)).toEqual({
      command: "/custom/pi",
      args: ["-p"],
    });
  });

  it("parses the final assistant text from pi jsonl", () => {
    const output = [
      "{\"type\":\"message_update\"}",
      "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ROBOT_REVIEW_JSON_START {\\\"accepted\\\":true} ROBOT_REVIEW_JSON_END\"}]}}",
    ].join("\n");
    expect(extractFinalAssistantTextFromPiJsonl(output)).toContain("ROBOT_REVIEW_JSON_START");
  });

  it("uses configured timeout or falls back to default", () => {
    expect(getRobotReviewTimeoutMs({ PI_LGTM_ROBOT_REVIEW_TIMEOUT_MS: "2500" } as NodeJS.ProcessEnv)).toBe(2500);
    expect(getRobotReviewTimeoutMs({ PI_LGTM_ROBOT_REVIEW_TIMEOUT_MS: "bad" } as NodeJS.ProcessEnv)).toBe(DEFAULT_ROBOT_REVIEW_TIMEOUT_MS);
  });

  it("times out bounded child commands", async () => {
    await expect(runRobotReviewCommand({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
    }, undefined, 25)).rejects.toThrow(/timed out/i);
  });

  it("extracts assistant text from a child jsonl process", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({type:'message_update'}) + '\\n');",
      "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ROBOT_REVIEW_JSON_START {\\\"accepted\\\":true,\\\"observations\\\":[\\\"ok\\\"]} ROBOT_REVIEW_JSON_END'}]}}) + '\\n');",
    ].join("");
    const result = await runRobotReviewCommand({
      command: process.execPath,
      args: ["-e", script],
    }, undefined, 500);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ROBOT_REVIEW_JSON_END");
  });
});
