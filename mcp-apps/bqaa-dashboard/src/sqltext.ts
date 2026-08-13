// Browser-safe SQL text helpers shared by the CA bridge (Node) and the mock
// layer (bundled into the UI). No Node APIs.

// Exact BigQuery string literal: quotes, backslashes, and newlines are
// escaped rather than stripped, so a value scopes to precisely itself.
export function sqlStringLiteral(value: string): string {
  return `'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}'`;
}
