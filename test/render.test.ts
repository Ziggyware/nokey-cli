import assert from "node:assert/strict";
import test from "node:test";
import { cellsText, cellsWidth, graphemeWidth, sliceCells, strWidth, toCells, wrapCells } from "../src/util/cells.ts";
import { highlight, canonicalLang, languageLabel } from "../src/render/highlight.ts";
import { parseInline, parseMarkdown, extractCodeBlocks } from "../src/render/markdown.ts";
import { renderMarkdown } from "../src/render/markdown-render.ts";
import { getTheme } from "../src/ui/theme.ts";
import { estimateTokens, fmtTokens } from "../src/util/tokens.ts";
import { fuzzyMatch, fuzzyFilter } from "../src/util/fuzzy.ts";
import { rgbTo256, rgbTo16, stripAnsi, lineToAnsi } from "../src/util/ansi.ts";
import { parseKeys } from "../src/ui/keys.ts";

test("display widths: ascii, wide, emoji, combining", () => {
  assert.equal(strWidth("abc"), 3);
  assert.equal(graphemeWidth("世"), 2);
  assert.equal(strWidth("日本語"), 6);
  assert.equal(graphemeWidth("👍"), 2);
  assert.equal(graphemeWidth("e\u0301"), 1, "combining mark stays in its base grapheme");
  assert.equal(strWidth("a👨‍👩‍👧b"), 4);
});

test("cells round-trip and slice on grapheme boundaries", () => {
  const line = toCells([{ t: "abc世界", s: null }]);
  assert.equal(cellsWidth(line), 7);
  assert.equal(cellsText(line), "abc世界");
  // Slice from column 3: the wide char occupies 3..5.
  assert.equal(cellsText(sliceCells(line, 3, 5)), "世");
  // A wide cluster is dropped rather than split when it would overflow the range.
  assert.equal(cellsWidth(sliceCells(line, 0, 4)), 3);
  assert.equal(cellsText(sliceCells(line, 0, 5)), "abc世");
  assert.equal(cellsWidth(sliceCells(line, 0, 5)), 5);
});

test("wrap never exceeds the width and preserves words", () => {
  const width = 20;
  const line = toCells([{ t: "the quick brown fox jumps over the lazy dog and keeps running", s: null }]);
  const wrapped = wrapCells(line, width);
  assert.ok(wrapped.length > 1);
  for (const row of wrapped) assert.ok(cellsWidth(row) <= width, `row too wide: ${cellsText(row)}`);
  assert.equal(wrapped.map(cellsText).join(" ").replace(/\s+/g, " ").trim(), "the quick brown fox jumps over the lazy dog and keeps running");
});

test("wrap hard-breaks unbreakable tokens", () => {
  const long = "x".repeat(50);
  const wrapped = wrapCells(toCells([{ t: long, s: null }]), 10);
  for (const row of wrapped) assert.ok(cellsWidth(row) <= 10);
  assert.equal(wrapped.map(cellsText).join(""), long);
});

test("hanging indent applies to continuation lines", () => {
  const wrapped = wrapCells(toCells([{ t: "one two three four five six seven", s: null }]), 12, { hang: 2 });
  for (let i = 1; i < wrapped.length; i++) assert.equal(cellsText(wrapped[i]!).startsWith("  "), true);
});

test("syntax highlighting classifies the important tokens", () => {
  const lines = highlight('const x: string = "hi"; // note\n/* multi\nline */ function f() {}', "ts");
  const flat = lines.flat();
  const kinds = new Map(flat.map((t) => [t.t, t.k]));
  assert.equal(kinds.get("const"), "kw");
  assert.equal(kinds.get("string"), "type");
  assert.equal(kinds.get('"hi"'), "str");
  assert.equal(kinds.get("// note"), "comment");
  assert.equal(kinds.get("/* multi\nline */"), "comment", "block comment keeps state across lines");
  assert.equal(kinds.get("f"), "fn");
});

test("python triple-quoted strings stay strings across lines", () => {
  const lines = highlight('x = """line one\nstill string\nend"""\ny = 1', "py");
  const flat = lines.flat();
  assert.ok(flat.some((t) => t.k === "str" && t.t.includes("still string")));
  assert.ok(flat.some((t) => t.t === "1" && t.k === "num"));
});

test("json keys are attributes", () => {
  const lines = highlight('{"name": "nokey", "count": 3}', "json");
  const attrs = lines.flat().filter((t) => t.k === "attr").map((t) => t.t);
  assert.deepEqual(attrs, ['"name"', '"count"']);
});

test("diff and markup languages render", () => {
  const diff = highlight("- old\n+ new\n@@ hunk @@", "diff").flat();
  assert.ok(diff.some((t) => t.k === "removed"));
  assert.ok(diff.some((t) => t.k === "added"));
  assert.ok(diff.some((t) => t.k === "diffHunk"));
  const html = highlight('<a href="/x">link</a>', "html").flat();
  assert.ok(html.some((t) => t.k === "tag" && t.t === "a"));
  assert.ok(html.some((t) => t.k === "attr" && t.t === "href"));
});

test("language aliases resolve to canonical names", () => {
  assert.equal(canonicalLang("tsx"), "typescript");
  assert.equal(canonicalLang("language-python"), "python");
  assert.equal(canonicalLang("weirdlang"), null);
  assert.equal(languageLabel("rs"), "Rust");
});

test("markdown parser handles headings, lists, tables, fences", () => {
  const blocks = parseMarkdown("# Title\n\ntext\n\n- a\n- b\n\n| x | y |\n|:--|--:|\n| 1 | 2 |\n\n```ts\ncode\n```");
  const kinds = blocks.map((b) => b.kind);
  assert.ok(kinds.includes("heading"));
  assert.ok(kinds.includes("paragraph"));
  assert.ok(kinds.includes("list"));
  assert.ok(kinds.includes("table"));
  assert.ok(kinds.includes("code"));
  const list = blocks.find((b) => b.kind === "list");
  assert.equal(list && list.kind === "list" ? list.items.length : 0, 2);
});

test("unterminated fence still produces a code block (streaming)", () => {
  const blocks = parseMarkdown("text\n\n```py\nprint(1)\nprint(2)");
  const code = blocks.find((b) => b.kind === "code");
  assert.ok(code && code.kind === "code");
  assert.equal(code.kind === "code" ? code.closed : true, false);
  assert.match(code.kind === "code" ? code.code : "", /print\(2\)/);
});

test("inline spans: bold, code, links, urls", () => {
  const spans = parseInline("a **b** `c` [d](https://e.f) https://g.h");
  assert.ok(spans.some((s) => s.text === "b" && s.bold));
  assert.ok(spans.some((s) => s.text === "c" && s.code));
  assert.ok(spans.some((s) => s.text === "d" && s.link === "https://e.f"));
  assert.ok(spans.some((s) => s.text.startsWith("https://g.h") && s.link));
});

test("rendered markdown fits the requested width", () => {
  const md = "# H\n\nSome **bold** prose that should wrap cleanly when the width is small.\n\n- item one\n- item two\n\n```ts\nconst x = 1;\n```";
  const lines = renderMarkdown(md, { theme: getTheme("midnight"), width: 40, lineNumbers: true });
  assert.ok(lines.length > 5);
  for (const line of lines) assert.ok(cellsWidth(line) <= 40 + 1, `too wide (${cellsWidth(line)}): ${cellsText(line)}`);
});

test("tables shrink to fit narrow viewports", () => {
  const md = "| column one | column two | column three |\n|:--|:--|:--|\n| aaaa | bbbb | cccc |";
  const lines = renderMarkdown(md, { theme: getTheme("midnight"), width: 30 });
  for (const line of lines) assert.ok(cellsWidth(line) <= 30);
});

test("extractCodeBlocks finds fences with metadata", () => {
  const blocks = extractCodeBlocks('```ts title="a.ts"\nconst a = 1;\n```\n\n```sh\nls\n```');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.lang, "ts");
  assert.match(blocks[0]!.meta, /a\.ts/);
});

test("token estimation is monotonic and roughly calibrated", () => {
  const prose = "The router learns from every request and keeps the winners ranked.";
  const tokens = estimateTokens(prose);
  assert.ok(tokens > prose.length / 6 && tokens < prose.length / 3, `unexpected estimate ${tokens}`);
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("a".repeat(400)) > estimateTokens("a".repeat(100)));
  assert.equal(fmtTokens(1500), "1.5k");
});

test("fuzzy matching prefers prefixes and word starts", () => {
  const prefix = fuzzyMatch("mem", "memory");
  const scattered = fuzzyMatch("mem", "message memory");
  assert.ok(prefix && scattered);
  assert.ok(prefix!.score > scattered!.score);
  assert.equal(fuzzyMatch("zzz", "memory"), null);
  const ranked = fuzzyFilter([{ n: "sessions" }, { n: "set" }, { n: "search" }], "ses", (i) => i.n);
  assert.equal(ranked[0]!.item.n, "sessions");
});

test("ansi colour quantisation picks sane palette entries", () => {
  assert.equal(rgbTo256(255, 0, 0), 196);
  assert.ok(rgbTo256(20, 20, 20) >= 232);
  assert.equal(rgbTo16(0, 0, 0), 0);
  assert.equal(rgbTo16(255, 255, 255), 15);
  const cellsLine = toCells([{ t: "hi", s: { fg: "#ff0000", bold: true } }]);
  const ansi = lineToAnsi(cellsLine, { colorMode: "truecolor" });
  assert.match(ansi, /\x1b\[/);
  assert.equal(stripAnsi(ansi), "hi");
  assert.equal(lineToAnsi(cellsLine, { colorMode: "none" }), "hi");
});

test("key parser decodes arrows, ctrl keys, paste and alt-enter", () => {
  const plain = parseKeys("abc");
  assert.deepEqual(plain.keys.map((k) => k.key), ["a", "b", "c"]);
  const arrows = parseKeys("\x1b[A\x1b[B\x1b[1;5C");
  assert.deepEqual(arrows.keys.map((k) => k.key), ["up", "down", "right"]);
  assert.equal(arrows.keys[2]!.ctrl, true);
  const ctrl = parseKeys("\x03");
  assert.equal(ctrl.keys[0]!.key, "c");
  assert.equal(ctrl.keys[0]!.ctrl, true);
  const paste = parseKeys("\x1b[200~hello\nworld\x1b[201~");
  assert.equal(paste.keys[0]!.key, "paste");
  assert.equal(paste.keys[0]!.paste, "hello\nworld");
  const altEnter = parseKeys("\x1b\r");
  assert.equal(altEnter.keys[0]!.key, "enter");
  assert.equal(altEnter.keys[0]!.alt, true);
  const partial = parseKeys("\x1b[");
  assert.equal(partial.pending, "\x1b[");
  assert.equal(partial.keys.length, 0);
});
