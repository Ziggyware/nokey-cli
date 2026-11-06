/** Short, sortable, collision-resistant identifiers. */

let counter = 0;

function rand(n: number): string {
  let s = "";
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/** Time-ordered id: sorts lexicographically by creation time. */
export function newId(prefix = ""): string {
  counter = (counter + 1) % 1296;
  const ts = Date.now().toString(36).padStart(9, "0");
  return `${prefix}${ts}${counter.toString(36).padStart(2, "0")}${rand(4)}`;
}

export function shortId(id: string, len = 8): string {
  return id.length <= len ? id : id.slice(0, len);
}

/** Stable ordinal suffix for display ("3rd"). */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/** Random slug used for anonymous community/feedback identifiers. */
export function handle(): string {
  const adjectives = ["amber", "brisk", "cobalt", "dusty", "ember", "fuzzy", "glib", "hollow", "ivory", "jaded"];
  const nouns = ["wombat", "lynx", "otter", "heron", "gecko", "marten", "pika", "quokka", "tapir", "wren"];
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]}-${nouns[Math.floor(Math.random() * nouns.length)]}-${rand(3)}`;
}
