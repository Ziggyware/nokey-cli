/**
 * Syntax highlighting.
 *
 * A small, stateful scanner rather than a pile of regexes: multi-line block
 * comments, template strings, heredocs and Python triple-quoted strings keep
 * their state across lines, which is what makes long pasted code look right.
 *
 * The output is a list of typed tokens per line; colour is applied later by the
 * renderer through the theme, so highlighting is theme-independent and testable.
 */

export type TokenType =
  | "plain"
  | "kw"
  | "str"
  | "num"
  | "comment"
  | "fn"
  | "type"
  | "var"
  | "op"
  | "punct"
  | "regex"
  | "tag"
  | "attr"
  | "builtin"
  | "meta"
  | "escape"
  | "const"
  | "added"
  | "removed"
  | "diffHunk";

export interface Token {
  t: string;
  k: TokenType;
}

type Line = Token[];

interface StringSpec {
  /** Opening delimiter. */
  open: string;
  /** Closing delimiter (defaults to `open`). */
  close?: string;
  /** May span lines. */
  multiline?: boolean;
  /** `${...}` / `#{}` interpolation is highlighted as code. */
  interpolate?: boolean;
  /** Prefixes that switch the string into raw mode (e.g. python r"", c++ R"()"). */
  prefixes?: string[];
}

interface Lang {
  name: string;
  label: string;
  aliases: string[];
  keywords?: string[];
  types?: string[];
  builtins?: string[];
  constants?: string[];
  lineComment?: string[];
  blockComment?: [string, string];
  strings?: StringSpec[];
  /** Additional multi-line delimiters (python triple quotes). */
  tripleQuotes?: string[];
  /** `#` starts a line comment only at line start (preprocessor). */
  hashIsPreprocessor?: boolean;
  /** Treat `name:` as an attribute (JSON/CSS/YAML). */
  colonAttrs?: boolean;
  /** `@word` is a decorator/annotation. */
  decorators?: boolean;
  /** `<tag attr="x">` scanner. */
  markup?: boolean;
  /** `/re/flags` scanner. */
  regexLiterals?: boolean;
  /** Case-insensitive keywords (SQL). */
  caseInsensitive?: boolean;
  /** Language name shown in the code fence badge. */
  fence?: string[];
}

const jsKeywords =
  "as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return satisfies set static super switch this throw true try typeof undefined var void while with yield type declare keyof infer assert namespace is abstract override".split(
    " ",
  );

const jsTypes =
  "any bigint boolean never number object string symbol unknown void Array Promise Record Map Set WeakMap WeakSet Date RegExp Error JSON Math console React HTMLElement Element Node Document Window Response Request URL URLSearchParams Headers AbortController AbortSignal ReadableStream TextDecoder TextEncoder".split(
    " ",
  );

const pyKeywords =
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case".split(
    " ",
  );

const pyBuiltins =
  "abs all any ascii bin bool bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip self cls".split(
    " ",
  );

const rustKeywords =
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while union macro_rules".split(
    " ",
  );

const rustTypes = "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap HashSet Cow".split(" ");

const goKeywords =
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota".split(" ");

const goTypes = "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any".split(" ");

const cKeywords =
  "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Atomic _Bool class namespace template typename public private protected virtual override new delete this nullptr true false using operator constexpr consteval noexcept friend explicit mutable static_cast dynamic_cast reinterpret_cast const_cast throw try catch co_await co_return co_yield concept requires".split(
    " ",
  );

const cTypes = "bool size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t float double void char wchar_t string vector map unordered_map unique_ptr shared_ptr optional variant auto".split(" ");

const javaKeywords =
  "abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var void volatile while record sealed permits yield true false null".split(
    " ",
  );

const csharpKeywords =
  "abstract as async await base break case catch class const continue default delegate do else enum event explicit extern false finally fixed for foreach get goto if implicit in interface internal is lock namespace new null object operator out override params private protected public readonly record ref return sealed set sizeof stackalloc static struct switch this throw true try typeof using var virtual void volatile when where while with yield".split(
    " ",
  );

const sqlKeywords =
  "select from where and or not insert into values update set delete create table alter drop index view join left right inner outer full on group by order having limit offset union all distinct as case when then else end exists in between like ilike is null asc desc primary key foreign references default constraint unique check returning with recursive begin commit rollback transaction if".split(
    " ",
  );

const shellKeywords =
  "if then else elif fi for while until do done case esac function return in select break continue local export readonly declare unset shift source alias echo cd pwd exit test set trap wait eval exec".split(
    " ",
  );

const builtinKeywords = "true false null undefined nil None True False self this super".split(" ");

const LANGS: Lang[] = [
  {
    name: "typescript",
    label: "TypeScript",
    fence: ["ts", "typescript", "tsx", "mts", "cts"],
    aliases: ["ts", "typescript", "tsx", "mts", "cts"],
    keywords: [...jsKeywords, "interface", "implements", "declare", "enum", "namespace", "abstract", "readonly", "satisfies", "infer", "keyof", "asserts", "unique"],
    types: jsTypes,
    builtins: builtinKeywords,
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [
      { open: "`", interpolate: true, multiline: true },
      { open: '"', interpolate: true },
      { open: "'", interpolate: true },
    ],
    regexLiterals: true,
    decorators: true,
    colonAttrs: false,
  },
  {
    name: "javascript",
    label: "JavaScript",
    fence: ["js", "javascript", "jsx", "mjs", "cjs", "node"],
    aliases: ["js", "javascript", "jsx", "mjs", "cjs", "node", "deno"],
    keywords: jsKeywords,
    types: jsTypes,
    builtins: builtinKeywords,
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [
      { open: "`", interpolate: true, multiline: true },
      { open: '"', interpolate: true },
      { open: "'", interpolate: true },
    ],
    regexLiterals: true,
    decorators: true,
  },
  {
    name: "python",
    label: "Python",
    fence: ["py", "python", "python3", "py3"],
    aliases: ["py", "python", "python3", "py3"],
    keywords: pyKeywords,
    builtins: pyBuiltins,
    lineComment: ["#"],
    strings: [
      { open: '"""', close: '"""', multiline: true, interpolate: true, prefixes: ["r", "b", "f", "u", "rb", "br", "fr", "rf"] },
      { open: "'''", close: "'''", multiline: true, interpolate: true, prefixes: ["r", "b", "f", "u", "rb", "br", "fr", "rf"] },
      { open: '"', interpolate: true, prefixes: ["r", "b", "f", "u", "rb", "br", "fr", "rf"] },
      { open: "'", interpolate: true, prefixes: ["r", "b", "f", "u", "rb", "br", "fr", "rf"] },
    ],
    decorators: true,
  },
  {
    name: "rust",
    label: "Rust",
    fence: ["rs", "rust"],
    aliases: ["rs", "rust"],
    keywords: rustKeywords,
    types: rustTypes,
    builtins: builtinKeywords,
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
    decorators: false,
  },
  {
    name: "go",
    label: "Go",
    fence: ["go", "golang"],
    aliases: ["go", "golang"],
    keywords: goKeywords,
    types: goTypes,
    builtins: builtinKeywords,
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [{ open: "`", multiline: true }, { open: '"', interpolate: true }, { open: "'", close: "'" }],
  },
  {
    name: "c",
    label: "C / C++",
    fence: ["c", "h", "cpp", "c++", "cc", "hpp", "cxx"],
    aliases: ["c", "h", "cpp", "c++", "cc", "hpp", "cxx", "objective-c", "objc"],
    keywords: cKeywords,
    types: cTypes,
    builtins: builtinKeywords,
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
    hashIsPreprocessor: true,
  },
  {
    name: "java",
    label: "Java",
    fence: ["java"],
    aliases: ["java"],
    keywords: javaKeywords,
    types: "byte short int long float double boolean char String Object Integer Double Boolean List Map Set ArrayList HashMap Optional Stream".split(" "),
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '"""', close: '"""', multiline: true }, { open: '"', interpolate: true }, { open: "'", close: "'" }],
    decorators: true,
  },
  {
    name: "kotlin",
    label: "Kotlin",
    fence: ["kt", "kotlin", "kts"],
    aliases: ["kt", "kotlin", "kts"],
    keywords:
      "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg".split(
        " ",
      ),
    types: "Int Long Short Byte Double Float Boolean Char String Any Unit Nothing List Map Set MutableList Array".split(" "),
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '"""', close: '"""', multiline: true, interpolate: true }, { open: '"', interpolate: true }, { open: "'", close: "'" }],
    decorators: true,
  },
  {
    name: "csharp",
    label: "C#",
    fence: ["cs", "csharp", "c#"],
    aliases: ["cs", "csharp", "c#"],
    keywords: csharpKeywords,
    types: "bool byte char decimal double float int long object sbyte short string uint ulong ushort var dynamic List Dictionary Task IEnumerable".split(" "),
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '@"', multiline: true }, { open: '"', interpolate: true }, { open: "'", close: "'" }],
  },
  {
    name: "ruby",
    label: "Ruby",
    fence: ["rb", "ruby"],
    aliases: ["rb", "ruby"],
    keywords:
      "alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader include extend prepend lambda proc raise puts print p".split(
        " ",
      ),
    builtins: builtinKeywords,
    lineComment: ["#"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
  },
  {
    name: "php",
    label: "PHP",
    fence: ["php"],
    aliases: ["php"],
    keywords:
      "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null".split(
        " ",
      ),
    builtins: builtinKeywords,
    lineComment: ["//", "#"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
  },
  {
    name: "swift",
    label: "Swift",
    fence: ["swift"],
    aliases: ["swift"],
    keywords:
      "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self throw throws true try async await some any actor".split(
        " ",
      ),
    types: "Int Double Float String Bool Array Dictionary Set Optional Result Any Void Character".split(" "),
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '"""', close: '"""', multiline: true, interpolate: true }, { open: '"', interpolate: true }],
    decorators: true,
  },
  {
    name: "sql",
    label: "SQL",
    fence: ["sql", "postgres", "postgresql", "mysql", "sqlite", "tsql", "plsql"],
    aliases: ["sql", "postgres", "postgresql", "mysql", "sqlite", "tsql", "plsql"],
    keywords: sqlKeywords,
    types: "int integer bigint smallint serial text varchar char boolean date timestamp timestamptz numeric decimal real double json jsonb uuid bytea array".split(" "),
    lineComment: ["--"],
    blockComment: ["/*", "*/"],
    strings: [{ open: "'", close: "'", multiline: true }, { open: '"', close: '"' }],
    caseInsensitive: true,
  },
  {
    name: "bash",
    label: "Shell",
    fence: ["bash", "sh", "shell", "zsh", "console", "terminal", "fish"],
    aliases: ["bash", "sh", "shell", "zsh", "console", "terminal", "fish", "shellsession"],
    keywords: shellKeywords,
    builtins: "awk sed grep rg find curl wget git npm pnpm yarn deno node python docker kubectl jq tar ssh scp make sudo".split(" "),
    lineComment: ["#"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
  },
  {
    name: "json",
    label: "JSON",
    fence: ["json", "jsonc", "json5", "ndjson"],
    aliases: ["json", "jsonc", "json5", "ndjson", "geojson"],
    keywords: ["true", "false", "null"],
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '"' }],
    colonAttrs: true,
  },
  {
    name: "yaml",
    label: "YAML",
    fence: ["yaml", "yml"],
    aliases: ["yaml", "yml"],
    keywords: ["true", "false", "null", "yes", "no", "on", "off", "~"],
    lineComment: ["#"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
    colonAttrs: true,
  },
  {
    name: "toml",
    label: "TOML",
    fence: ["toml", "ini", "cfg", "conf", "properties", "env"],
    aliases: ["toml", "ini", "cfg", "conf", "properties", "env", "dotenv"],
    keywords: ["true", "false"],
    lineComment: ["#", ";"],
    strings: [{ open: '"""', close: '"""', multiline: true }, { open: "'", close: "'" }, { open: '"' }],
    colonAttrs: true,
  },
  {
    name: "html",
    label: "HTML",
    fence: ["html", "htm", "xml", "svg", "vue", "svelte", "astro"],
    aliases: ["html", "htm", "xml", "svg", "vue", "svelte", "astro", "xhtml", "markup"],
    markup: true,
  },
  {
    name: "css",
    label: "CSS",
    fence: ["css", "scss", "less", "sass", "stylus"],
    aliases: ["css", "scss", "less", "sass", "stylus", "tailwind"],
    keywords: ["@media", "@import", "@keyframes", "@font-face", "@supports", "@layer", "@container", "important", "from", "to"],
    blockComment: ["/*", "*/"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
    colonAttrs: true,
  },
  {
    name: "markdown",
    label: "Markdown",
    fence: ["md", "markdown", "mdx", "mdown"],
    aliases: ["md", "markdown", "mdx", "mdown"],
    lineComment: [],
    strings: [{ open: "`", close: "`" }],
  },
  {
    name: "diff",
    label: "Diff",
    fence: ["diff", "patch", "udiff"],
    aliases: ["diff", "patch", "udiff"],
  },
  {
    name: "dockerfile",
    label: "Dockerfile",
    fence: ["dockerfile", "docker", "containerfile"],
    aliases: ["dockerfile", "docker", "containerfile"],
    keywords: "FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL".split(" "),
    lineComment: ["#"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
    caseInsensitive: true,
  },
  {
    name: "lua",
    label: "Lua",
    fence: ["lua"],
    aliases: ["lua"],
    keywords: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while".split(" "),
    lineComment: ["--"],
    strings: [{ open: "[[", close: "]]", multiline: true }, { open: '"', interpolate: true }, { open: "'", close: "'" }],
  },
  {
    name: "zig",
    label: "Zig",
    fence: ["zig"],
    aliases: ["zig"],
    keywords: "align allowzero and anyframe anytype asm async await break catch comptime const continue defer else enum errdefer error export extern fn for if inline noalias noinline nosuspend opaque or orelse packed pub resume return linksection struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while true false null undefined".split(
      " ",
    ),
    types: "i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 usize isize f16 f32 f64 f128 bool void noreturn type anyerror comptime_int comptime_float".split(" "),
    lineComment: ["//"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
    decorators: false,
  },
  {
    name: "elixir",
    label: "Elixir",
    fence: ["ex", "exs", "elixir"],
    aliases: ["ex", "exs", "elixir"],
    keywords: "def defp defmodule defmacro defstruct do end fn case cond if unless else when and or not in with for receive after try rescue catch raise import alias use require true false nil".split(
      " ",
    ),
    lineComment: ["#"],
    strings: [{ open: '"""', close: '"""', multiline: true, interpolate: true }, { open: '"', interpolate: true }, { open: "'", close: "'" }],
    decorators: true,
  },
  {
    name: "r",
    label: "R",
    fence: ["r", "rscript"],
    aliases: ["r", "rscript"],
    keywords: "if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA library require return".split(" "),
    lineComment: ["#"],
    strings: [{ open: '"', interpolate: true }, { open: "'", close: "'" }],
  },
  {
    name: "graphql",
    label: "GraphQL",
    fence: ["graphql", "gql"],
    aliases: ["graphql", "gql"],
    keywords: "query mutation subscription fragment on type interface union enum input scalar directive extend schema implements".split(" "),
    lineComment: ["#"],
    strings: [{ open: '"""', close: '"""', multiline: true }, { open: '"' }],
  },
  {
    name: "http",
    label: "HTTP",
    fence: ["http", "https", "rest", "curl"],
    aliases: ["http", "https", "rest"],
    lineComment: ["#"],
    strings: [{ open: '"', interpolate: true }],
  },
  {
    name: "plaintext",
    label: "Text",
    fence: ["text", "txt", "plain", "plaintext", "log", "output", "none"],
    aliases: ["text", "txt", "plain", "plaintext", "log", "output", "none", ""],
  },
];

const ALIAS = new Map<string, Lang>();
for (const lang of LANGS) for (const alias of lang.aliases) ALIAS.set(alias.toLowerCase(), lang);

export const LANGUAGE_NAMES = LANGS.filter((l) => l.name !== "plaintext").map((l) => l.name);

/** Canonical language name for a fence alias, or null when unknown. */
export function canonicalLang(alias: string | undefined): string | null {
  if (!alias) return "plaintext";
  const key = alias.trim().toLowerCase().replace(/^language-/, "");
  const lang = ALIAS.get(key);
  return lang ? lang.name : null;
}

/** Human label for the code-fence badge. */
export function languageLabel(alias: string | undefined): string {
  if (!alias) return "";
  const key = alias.trim().toLowerCase();
  const lang = ALIAS.get(key);
  return lang ? lang.label : alias.trim();
}

const ID_START = /[A-Za-z_$@\\\u00c0-\uffff]/;
const ID_PART = /[A-Za-z0-9_$\\\u00c0-\uffff]/;
const DIGIT = /[0-9]/;

interface State {
  blockEnd: string | null;
  tripleEnd: string | null;
  heredocEnd: string | null;
  templateBacktick: boolean;
}

/** Highlight a whole snippet. Returns one token list per line. */
export function highlight(code: string, alias?: string): Line[] {
  const lang = ALIAS.get((alias ?? "").toLowerCase()) ?? ALIAS.get("plaintext")!;
  if (lang.name === "plaintext") return plainLines(code);
  if (lang.name === "diff") return diffLines(code);
  if (lang.markup) return markupLines(code, lang);
  if (lang.name === "markdown") return markdownLines(code);
  const lines = codeLines(code, lang);
  if (lang.colonAttrs) markColonAttrs(lines);
  return lines;
}

function plainLines(code: string): Line[] {
  return code.split("\n").map((line) => (line.length ? [{ t: line, k: "plain" }] : []));
}

function pushLine(lines: Line[], line: Line): void {
  lines.push(line);
}

function diffLines(code: string): Line[] {
  const lines: Line[] = [];
  for (const raw of code.split("\n")) {
    let k: TokenType = "plain";
    if (/^(\+\+\+|---|diff --git|index |new file|deleted file|similarity |rename )/.test(raw)) k = "meta";
    else if (raw.startsWith("@@")) k = "diffHunk";
    else if (raw.startsWith("+")) k = "added";
    else if (raw.startsWith("-")) k = "removed";
    pushLine(lines, raw.length ? [{ t: raw, k }] : []);
  }
  return lines;
}

function markdownLines(code: string): Line[] {
  const lines: Line[] = [];
  for (const raw of code.split("\n")) {
    if (/^#{1,6}\s/.test(raw)) {
      const m = /^(#{1,6})(\s+)(.*)$/.exec(raw)!;
      pushLine(lines, [
        { t: m[1]!, k: "kw" },
        { t: m[2]!, k: "plain" },
        { t: m[3]!, k: "type" },
      ]);
    } else if (/^\s*([-*+]|\d+\.)\s/.test(raw)) {
      const m = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/.exec(raw)!;
      pushLine(lines, [
        { t: m[1]!, k: "plain" },
        { t: m[2]!, k: "op" },
        { t: m[3]!, k: "plain" },
        ...inlineMd(m[4]!),
      ]);
    } else if (/^\s*>/.test(raw)) {
      pushLine(lines, [{ t: raw, k: "comment" }]);
    } else if (/^\s*(```|~~~)/.test(raw)) {
      pushLine(lines, [{ t: raw, k: "meta" }]);
    } else {
      pushLine(lines, raw.length ? inlineMd(raw) : []);
    }
  }
  return lines;
}

function inlineMd(text: string): Line {
  const out: Line = [];
  const re = /(`[^`]*`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: text.slice(last, idx), k: "plain" });
    const tok = m[0];
    if (tok.startsWith("`")) out.push({ t: tok, k: "str" });
    else if (tok.startsWith("[")) out.push({ t: tok, k: "attr" });
    else out.push({ t: tok, k: "type" });
    last = idx + tok.length;
  }
  if (last < text.length) out.push({ t: text.slice(last), k: "plain" });
  return out;
}

function markupLines(code: string, lang: Lang): Line[] {
  const lines: Line[] = [];
  let inComment = false;
  for (const raw of code.split("\n")) {
    const line: Line = [];
    let i = 0;
    while (i < raw.length) {
      if (inComment) {
        const end = raw.indexOf("-->", i);
        if (end === -1) {
          line.push({ t: raw.slice(i), k: "comment" });
          i = raw.length;
        } else {
          line.push({ t: raw.slice(i, end + 3), k: "comment" });
          i = end + 3;
          inComment = false;
        }
        continue;
      }
      if (raw.startsWith("<!--", i)) {
        inComment = true;
        line.push({ t: "<!--", k: "comment" });
        i += 4;
        continue;
      }
      if (raw[i] === "<") {
        const m = /^<\/?([A-Za-z][\w:.-]*)/.exec(raw.slice(i));
        if (m) {
          line.push({ t: raw.slice(i, i + (raw[i + 1] === "/" ? 1 : 0)), k: "punct" });
          const start = i + (raw[i + 1] === "/" ? 1 : 0);
          line.push({ t: raw.slice(start, start + 1), k: "punct" });
          line.push({ t: m[1]!, k: "tag" });
          i = start + 1 + m[1]!.length;
          // attributes
          while (i < raw.length && raw[i] !== ">") {
            const rest = raw.slice(i);
            const attr = /^\s*([A-Za-z_:@][\w:.-]*)/.exec(rest);
            if (attr && attr[0].trim()) {
              const lead = /^\s*/.exec(rest)![0];
              if (lead) line.push({ t: lead, k: "plain" });
              line.push({ t: attr[1]!, k: "attr" });
              i += lead.length + attr[1]!.length;
              const eq = /^\s*=\s*/.exec(raw.slice(i));
              if (eq) {
                line.push({ t: eq[0], k: "op" });
                i += eq[0].length;
                const q = raw[i];
                if (q === '"' || q === "'") {
                  const end = raw.indexOf(q, i + 1);
                  const stop = end === -1 ? raw.length : end + 1;
                  line.push({ t: raw.slice(i, stop), k: "str" });
                  i = stop;
                }
              }
              continue;
            }
            line.push({ t: raw[i]!, k: "punct" });
            i++;
          }
          if (raw[i] === ">") {
            line.push({ t: ">", k: "punct" });
            i++;
          }
          continue;
        }
      }
      if (raw[i] === "&") {
        const ent = /^&[#\w]+;/.exec(raw.slice(i));
        if (ent) {
          line.push({ t: ent[0], k: "escape" });
          i += ent[0].length;
          continue;
        }
      }
      // plain text up to the next '<'
      const next = raw.indexOf("<", i);
      const stop = next === -1 ? raw.length : next;
      line.push({ t: raw.slice(i, stop), k: "plain" });
      i = stop;
    }
    pushLine(lines, line);
  }
  void lang;
  return lines;
}

function codeLines(code: string, lang: Lang): Line[] {
  const lines: Line[] = [];
  let line: Line = [];
  const state: State = { blockEnd: null, tripleEnd: null, heredocEnd: null, templateBacktick: false };
  const kw = new Set(lang.caseInsensitive ? lang.keywords?.map((k) => k.toLowerCase()) : lang.keywords);
  const types = new Set(lang.caseInsensitive ? lang.types?.map((k) => k.toLowerCase()) : lang.types);
  const builtins = new Set(lang.caseInsensitive ? lang.builtins?.map((k) => k.toLowerCase()) : lang.builtins);
  const constants = new Set(lang.constants);
  const lineComments = lang.lineComment ?? [];
  const text = code;
  let i = 0;
  let prevSignificant = "";

  const add = (t: string, k: TokenType) => {
    if (!t) return;
    const last = line[line.length - 1];
    if (last && last.k === k) last.t += t;
    else line.push({ t, k });
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\n") {
      pushLine(lines, line);
      line = [];
      i++;
      prevSignificant = "";
      continue;
    }

    if (state.blockEnd) {
      const end = text.indexOf(state.blockEnd, i);
      if (end === -1) {
        add(text.slice(i), "comment");
        i = text.length;
      } else {
        add(text.slice(i, end + state.blockEnd.length), "comment");
        i = end + state.blockEnd.length;
        state.blockEnd = null;
      }
      continue;
    }

    if (state.tripleEnd) {
      const end = text.indexOf(state.tripleEnd, i);
      if (end === -1) {
        add(text.slice(i), "str");
        i = text.length;
      } else {
        add(text.slice(i, end + state.tripleEnd.length), "str");
        i = end + state.tripleEnd.length;
        state.tripleEnd = null;
      }
      continue;
    }

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\r") {
      const m = /^[ \t\r]+/.exec(text.slice(i))!;
      add(m[0], "plain");
      i += m[0].length;
      continue;
    }

    // line comments
    let matchedLineComment = false;
    for (const marker of lineComments) {
      if (text.startsWith(marker, i)) {
        if (lang.hashIsPreprocessor && marker === "#") {
          // Only a comment when not at the start of a preprocessor directive line.
          const lineStart = text.lastIndexOf("\n", i) + 1;
          const before = text.slice(lineStart, i);
          if (before.trim() === "") {
            add(marker, "meta");
            i += marker.length;
            matchedLineComment = true;
            break;
          }
          continue;
        }
        const end = text.indexOf("\n", i);
        const stop = end === -1 ? text.length : end;
        add(text.slice(i, stop), "comment");
        i = stop;
        matchedLineComment = true;
        break;
      }
    }
    if (matchedLineComment) continue;

    // preprocessor / directives at line start
    if (lang.hashIsPreprocessor && ch === "#" && /(^|\n)[ \t]*$/.test(text.slice(0, i))) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      add(text.slice(i, stop), "meta");
      i = stop;
      continue;
    }

    // block comments
    if (lang.blockComment && text.startsWith(lang.blockComment[0], i)) {
      const [open, close] = lang.blockComment;
      const end = text.indexOf(close, i + open.length);
      if (end === -1) {
        add(text.slice(i), "comment");
        i = text.length;
        state.blockEnd = close;
      } else {
        add(text.slice(i, end + close.length), "comment");
        i = end + close.length;
      }
      continue;
    }

    // decorators
    if (lang.decorators && ch === "@" && ID_START.test(text[i + 1] ?? "")) {
      const m = /^@[\w.$]+/.exec(text.slice(i))!;
      add(m[0], "meta");
      i += m[0].length;
      continue;
    }

    // strings (including prefixed ones like f"", r'')
    const strSpec = matchString(text, i, lang);
    if (strSpec) {
      const { spec, prefixLen } = strSpec;
      if (prefixLen) add(text.slice(i, i + prefixLen), "meta");
      const openIdx = i + prefixLen;
      const close = spec.close ?? spec.open;
      let j = openIdx + spec.open.length;
      let value = spec.open;
      let closed = false;
      while (j < text.length) {
        const c = text[j]!;
        if (c === "\\" && !(spec.prefixes?.length && prefixLen > 0 && /[rR]/.test(text.slice(i, i + prefixLen)) && false)) {
          value += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (spec.interpolate && text.startsWith("${", j)) {
          // Highlight the interpolation body as code up to the matching brace.
          const end = findMatchingBrace(text, j + 2);
          value += text.slice(j, end);
          j = end;
          continue;
        }
        if (text.startsWith(close, j)) {
          value += close;
          j += close.length;
          closed = true;
          break;
        }
        if (c === "\n" && !spec.multiline) break;
        value += c;
        j++;
      }
      if (!closed && spec.multiline) {
        // Continue the string on subsequent lines.
        state.tripleEnd = close;
        state.templateBacktick = spec.open === "`";
      }
      add(value, "str");
      i = j;
      prevSignificant = "str";
      continue;
    }

    // numbers
    if (DIGIT.test(ch) || (ch === "." && DIGIT.test(text[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)([a-zA-Z_][\w]*)?/.exec(text.slice(i));
      if (m) {
        add(m[0], "num");
        i += m[0].length;
        prevSignificant = "num";
        continue;
      }
    }

    // regex literal (JS)
    if (lang.regexLiterals && ch === "/" && canStartRegex(prevSignificant)) {
      let j = i + 1;
      let value = "/";
      let inClass = false;
      let ok = false;
      while (j < text.length) {
        const c = text[j]!;
        if (c === "\n") break;
        if (c === "\\") {
          value += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        if (c === "/" && !inClass) {
          value += "/";
          j++;
          const flags = /^[a-z]*/.exec(text.slice(j))![0];
          value += flags;
          j += flags.length;
          ok = true;
          break;
        }
        value += c;
        j++;
      }
      if (ok && value.length > 1) {
        add(value, "regex");
        i = j;
        prevSignificant = "regex";
        continue;
      }
    }

    // identifiers / keywords
    if (ID_START.test(ch)) {
      const m = /^[A-Za-z_$\\\u00c0-\uffff][\w$\\\u00c0-\uffff]*/.exec(text.slice(i))!;
      const word = m[0];
      const lower = lang.caseInsensitive ? word.toLowerCase() : word;
      const after = text.slice(i + word.length);
      const isCall = /^\s*\(/.test(after);
      const isColonAttr = lang.colonAttrs && /^\s*:/.test(after);
      let kind: TokenType = "var";
      if (isColonAttr) kind = "attr";
      else if (kw.has(lower)) kind = "kw";
      else if (types.has(lower)) kind = "type";
      else if (builtins.has(lower)) kind = "builtin";
      else if (constants.has(lower)) kind = "const";
      else if (isCall) kind = "fn";
      else if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) kind = "const";
      else if (/^[A-Z]/.test(word)) kind = "type";
      add(word, kind);
      i += word.length;
      prevSignificant = kind === "kw" ? lower : "id";
      continue;
    }

    // operators and punctuation
    const opMatch = /^(?:===|!==|==|!=|<=|>=|=>|->|::|\+\+|--|\+=|-=|\*=|\/=|%=|&&|\|\||\?\?|\?\.|<<|>>|[+\-*/%=<>!&|^~?:])/.exec(text.slice(i));
    if (opMatch) {
      add(opMatch[0], "op");
      i += opMatch[0].length;
      prevSignificant = opMatch[0];
      continue;
    }
    const punctMatch = /^[()[\]{},;.]/.exec(text.slice(i));
    if (punctMatch) {
      add(punctMatch[0], "punct");
      i += 1;
      prevSignificant = punctMatch[0];
      continue;
    }

    add(ch, "plain");
    i++;
  }
  pushLine(lines, line);
  // A trailing newline produces a spurious empty final line; drop it so the
  // rendered block does not grow by one row every stream tick.
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0 && text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Promote `key:` to an attribute colour. JSON/CSS/YAML keys are often strings
 * or bare words, and both should read as the same thing.
 */
function markColonAttrs(lines: Line[]): void {
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const token = line[i]!;
      if (token.k !== "str" && token.k !== "plain" && token.k !== "var") continue;
      let j = i + 1;
      while (j < line.length && (line[j]!.k === "plain" && line[j]!.t.trim() === "")) j++;
      if (j < line.length && line[j]!.t === ":" && (line[j]!.k === "punct" || line[j]!.k === "op")) {
        // Skip values in `key: value` pairs that are clearly prose (YAML lists).
        token.k = "attr";
      }
    }
  }
}

function matchString(text: string, i: number, lang: Lang): { spec: StringSpec; prefixLen: number } | null {
  const specs = lang.strings ?? [];
  // Longest delimiters first so """ beats ".
  const ordered = [...specs].sort((a, b) => b.open.length - a.open.length);
  for (const spec of ordered) {
    if (spec.prefixes) {
      for (const prefix of [...spec.prefixes].sort((a, b) => b.length - a.length)) {
        if (text.startsWith(prefix + spec.open, i)) {
          const before = i === 0 ? "" : text[i - 1]!;
          if (before && ID_PART.test(before)) continue;
          return { spec, prefixLen: prefix.length };
        }
      }
    }
    if (text.startsWith(spec.open, i)) {
      const before = i === 0 ? "" : text[i - 1]!;
      if (before && ID_PART.test(before)) continue;
      return { spec, prefixLen: 0 };
    }
  }
  return null;
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === "\n" && depth > 0 && i - start > 4000) return i;
    i++;
  }
  return text.length;
}

function canStartRegex(prev: string): boolean {
  if (prev === "") return true;
  return ["=", "(", ",", ":", "[", "!", "&", "|", "?", "{", "}", ";", "return", "typeof", "case", "=>", "+", "-", "*", "%", "<", ">", "~", "^"].includes(prev);
}

/** Highlight a single line without any carried-over state (cheap inline use). */
export function highlightLine(code: string, alias?: string): Line {
  return highlight(code, alias)[0] ?? [];
}
