/** A note header starts at offset zero and ends at the first closing delimiter line. */
const BLOCK = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/

export function matchFrontmatter(content: string) {
  return BLOCK.exec(content)
}

export function stripFrontmatter(content: string): string {
  const block = matchFrontmatter(content)
  return block ? content.slice(block[0].length) : content
}
