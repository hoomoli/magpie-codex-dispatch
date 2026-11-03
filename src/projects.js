import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { withServer } from './rpc.js';
import { DispatchError } from './desktop.js';

export async function listProjects({ signal, server = withServer } = {}) {
  return server({ signal }, async client => {
    const projects = []; let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await client.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new DispatchError('PROTOCOL_MISMATCH', 'Invalid project catalog.');
      projects.push(...result.data.map(p => ({ id: p.id, name: p.name, roots: p.roots.map(r => r.path) })));
      cursor = result.nextCursor;
      if (!cursor) return { projects };
    }
    throw new DispatchError('CATALOG_TOO_LARGE', 'Project catalog exceeded the bounded listing limit.');
  });
}

export async function resolveProject(args, options) {
  let project;
  if (args.projectId || args.projectName) {
    const { projects } = await listProjects(options);
    const matches = projects.filter(p => (!args.projectId || p.id === args.projectId) && (!args.projectName || p.name === args.projectName));
    if (matches.length !== 1) throw new DispatchError('PROJECT_NOT_UNIQUE', 'Choose one canonical project ID from codex_projects. Desktop UI IDs can differ.');
    project = matches[0];
  }
  const selected = args.cwd ?? (project?.roots.length === 1 ? project.roots[0] : undefined);
  if (typeof selected !== 'string' || !isAbsolute(selected)) throw new DispatchError('PROJECT_REQUIRED', 'Specify a project with one root, or an explicit absolute cwd. Multiple roots require cwd.');
  const cwd = await realpath(selected).catch(() => null);
  if (!cwd || !(await stat(cwd)).isDirectory()) throw new DispatchError('INVALID_CWD', 'cwd must be an existing directory.');
  if (project) {
    const roots = await Promise.all(project.roots.map(root => realpath(root).catch(() => null)));
    if (!roots.some(root => { if (!root) return false; const rel = relative(root, cwd); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); })) {
      throw new DispatchError('PROJECT_PATH_MISMATCH', 'cwd is outside the selected project roots.');
    }
  }
  return { cwd, projectId: project?.id ?? null, projectName: project?.name ?? null };
}
