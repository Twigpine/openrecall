// Markdown imported as text (`import x from './file.md' with { type: 'text' }`).
// Bun loads these at runtime and the bundler inlines them into dist/.
declare module '*.md' {
  const content: string
  export default content
}
