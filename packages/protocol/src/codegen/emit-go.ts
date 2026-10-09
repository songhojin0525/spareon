import { GENERATED_HEADER } from './emit-ts.js';
import { type FieldIR, pascal, type ProtocolIR, type TypeIR } from './ir.js';

const goStr = (s: string): string => JSON.stringify(s); // ASCII-only inputs: JSON and Go escapes agree

function goType(t: TypeIR): string {
  switch (t.k) {
    case 'string':
      return 'string';
    case 'integer':
      return 'int64';
    case 'boolean':
      return 'bool';
    case 'literal':
      return typeof t.value === 'string' ? 'string' : 'int64';
    case 'array':
      return `[]${goType(t.items)}`;
    case 'named':
      return t.name;
  }
}

function fieldType(f: FieldIR): string {
  const base = goType(f.type);
  if (f.required || f.type.k === 'array') return base;
  return `*${base}`;
}

/** Renders rows of cells the way gofmt aligns them (tabwriter, padding 1, spaces). */
function aligned(rows: readonly (readonly string[])[], indent = '\t'): string[] {
  const widths: number[] = [];
  for (const r of rows) {
    r.forEach((c, i) => {
      if (i < r.length - 1) widths[i] = Math.max(widths[i] ?? 0, c.length);
    });
  }
  return rows.map(
    (r) =>
      indent + r.map((c, i) => (i < r.length - 1 ? c.padEnd((widths[i] ?? 0) + 1) : c)).join(''),
  );
}

export function emitGo(ir: ProtocolIR, protocolHash: string): string {
  const out: string[] = [`// ${GENERATED_HEADER}`, '', 'package protocol', ''];

  out.push('// ProtocolHash is the SHA-256 of the canonical schema bundle (bundle.json).');
  out.push(`const ProtocolHash = ${goStr(protocolHash)}`, '');

  out.push('// Protocol limits (schemas/limits.json).', 'const (');
  out.push(...aligned(ir.limits.map((l) => [`Limit${pascal(l.name)}`, `= ${String(l.value)}`])));
  out.push(')', '');

  out.push('// Message types (schemas/registry.json).', 'const (');
  out.push(...aligned(ir.messages.map((m) => [`Type${pascal(m.type)}`, `= ${goStr(m.type)}`])));
  out.push(')', '');

  for (const n of ir.named.values()) {
    if (n.k === 'enum') {
      out.push(`// ${n.name} is a closed set of wire values.`, `type ${n.name} string`, '');
      out.push(`// ${n.name} values.`, 'const (');
      out.push(...aligned(n.values.map((v) => [`${n.name}${pascal(v)}`, n.name, `= ${goStr(v)}`])));
      out.push(')', '');
    } else if (n.fields.length === 0) {
      out.push(`// ${n.name} has no fields.`, `type ${n.name} struct{}`, '');
    } else {
      out.push(`// ${n.name} is generated from the protocol schemas.`, `type ${n.name} struct {`);
      out.push(
        ...aligned(
          n.fields.map((f) => [
            pascal(f.json),
            fieldType(f),
            `\`json:"${f.json}${f.required ? '' : ',omitempty'}"\``,
          ]),
        ),
      );
      out.push('}', '');
      const requiredArrays = n.fields.filter((f) => f.required && f.type.k === 'array');
      if (requiredArrays.length > 0) {
        out.push(
          '// MarshalJSON writes nil required arrays as [] because the schemas forbid null.',
          `func (v ${n.name}) MarshalJSON() ([]byte, error) {`,
          `\ttype plain ${n.name}`,
        );
        for (const f of requiredArrays) {
          const name = pascal(f.json);
          out.push(`\tif v.${name} == nil {`, `\t\tv.${name} = ${fieldType(f)}{}`, '\t}');
        }
        out.push('\treturn marshal(plain(v))', '}', '');
      }
    }
  }

  const list = (xs: readonly string[]): string => `[]string{${xs.map(goStr).join(', ')}}`;
  out.push('var messageRegistry = []messageInfo{');
  for (const m of ir.messages) {
    out.push(
      `\t{Type: ${goStr(m.type)}, From: ${goStr(m.from)}, Corr: ${goStr(m.corr)}, Replies: ${list(m.replies)}, TimeoutMs: ${String(m.timeoutMs ?? 0)}},`,
    );
  }
  out.push('}', '');

  out.push('var httpRegistry = []httpInfo{');
  for (const h of ir.http) {
    out.push(
      `\t{Name: ${goStr(h.name)}, From: ${goStr(h.from)}, Method: ${goStr(h.method)}, Path: ${goStr(h.path)}, Replies: ${list(h.replies)}},`,
    );
  }
  out.push('}', '');

  out.push('var errorCodeRegistry = []errorCodeInfo{');
  for (const e of ir.errorCodes) {
    out.push(
      `\t{Code: ${goStr(e.code)}, From: ${goStr(e.from)}, Retryable: ${String(e.retryable)}, Fatal: ${String(e.fatal)}, AgentAction: ${goStr(e.agentAction)}},`,
    );
  }
  out.push('}', '');

  out.push('func newPayload(msgType string) any {', '\tswitch msgType {');
  for (const m of ir.messages) out.push(`\tcase ${goStr(m.type)}:`, `\t\treturn &${m.payload}{}`);
  out.push('\t}', '\treturn nil', '}', '');

  out.push('func newHTTPBody(name string) any {', '\tswitch name {');
  for (const h of ir.http) out.push(`\tcase ${goStr(h.name)}:`, `\t\treturn &${h.body}{}`);
  out.push('\t}', '\treturn nil', '}', '');

  out.push('func newManifest(kind string) any {', '\tswitch kind {');
  for (const m of ir.manifests) out.push(`\tcase ${goStr(m.kind)}:`, `\t\treturn &${m.type}{}`);
  out.push('\t}', '\treturn nil', '}', '');

  return out.join('\n');
}
