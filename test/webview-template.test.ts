/**
 * webview 的 JS 是写在 TS 模板字符串里的，而模板字符串会把 `\s` `\d` `\{` 这类
 * 「未知转义」的反斜杠吃掉——`/\s/` 到运行时变成 `/s/`，正则静默失效。
 *
 * 这个坑 tsc 和 esbuild 都看不见（它们只看到模板字符串本身），
 * 客观题的选项渲染不出来就是被它坑了，所以扫一遍模板里的字面文本。
 *
 * 运行：bun test
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 别用 new URL(...).pathname 再手动删开头的斜杠：在 Linux 上那是绝对路径的根，
// 删掉就变成相对路径了（Windows 上是 /D:/... 才恰好能用）。fileURLToPath 才是跨平台正解。
const root = fileURLToPath(new URL("..", import.meta.url));
const FILES = ["src/views/problemPanel.ts", "src/views/loginPanel.ts"];

/** 模板字符串里合法的转义（其余的都是被吃掉的反斜杠） */
const ALLOWED = new Set(["0", "b", "f", "n", "r", "t", "v", "'", '"', "`", "\\", "u", "x", "\n", "\r", "$"]);

describe("webview 模板", () => {
  test("脚本里的反斜杠没有被模板字符串吃掉", () => {
    const problems: string[] = [];

    for (const file of FILES) {
      const source = readFileSync(join(root, file), "utf8");
      const blocks = [...source.matchAll(/<script[^>]*>\n([\s\S]*?)<\/script>/g)];
      if (blocks.length === 0) {
        problems.push(`${file}：没找到 <script> 块，检查用的标记可能变了`);
        continue;
      }
      for (const block of blocks) {
        for (const line of block[1].split("\n")) {
          for (const match of line.matchAll(/\\(.)/g)) {
            if (!ALLOWED.has(match[1])) {
              problems.push(`${file} 脚本里可疑的转义 \\${match[1]}：${line.trim().slice(0, 80)}`);
            }
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });

  test("正则通过 JSON.stringify 注入，而不是写成正则字面量", () => {
    const source = readFileSync(join(root, "src/views/problemPanel.ts"), "utf8");
    const start = source.indexOf('<script nonce="${nonce}">');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("</script>", start));

    // 模板内不该再出现正则字面量：`/...\d.../` 这种一旦写进来就会被吃掉反斜杠
    const literal = /=\s*\/[^/\n]*\\[^/\n]*\/[gimsuy]*/.exec(body);
    expect(literal?.[0] ?? "").toBe("");
  });
});
