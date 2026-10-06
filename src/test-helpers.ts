import { Program } from 'brighterscript';

export function makeProgram(
  files: Record<string, string>,
  options: Record<string, unknown> = {},
): Program {
  const program = new Program({ rootDir: '/tmp/vv-test', ...options } as never);
  for (const [pkgPath, contents] of Object.entries(files)) program.setFile(pkgPath, contents);
  program.validate();
  return program;
}

export const xml = (name: string, body: string, ext = 'Group') =>
  `<?xml version="1.0" encoding="utf-8" ?>\n<component name="${name}" extends="${ext}">\n${body}\n</component>\n`;
