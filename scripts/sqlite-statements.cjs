// SQLite migration statements, including quoted semicolons and trigger bodies.
'use strict';
function splitSqliteStatements(sql) {
  const tokens =
    sql.match(
      /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|\b[A-Za-z_]+\b|;|[\s\S]/g,
    ) || [];
  let current = '',
    words = [],
    depth = 0;
  const statements = [];
  for (const token of tokens) {
    current += token;
    if (/^--|^\/\*|^['"`\[]/.test(token)) continue;
    if (/^[A-Za-z_]+$/.test(token)) {
      const word = token.toUpperCase();
      words.push(word);
      if (words.includes('TRIGGER')) {
        if (word === 'BEGIN' || word === 'CASE') depth++;
        if (word === 'END') depth--;
      }
    }
    if (token === ';' && depth === 0) {
      if (current.trim()) statements.push(current.slice(0, -1));
      current = '';
      words = [];
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}
module.exports = { splitSqliteStatements };
