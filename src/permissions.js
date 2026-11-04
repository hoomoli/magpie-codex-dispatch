import { DispatchError } from './errors.js';

export const permissionModes = ['inherit', 'read-only', 'ask-for-approval', 'auto-review', 'full-access'];
const profiles = { 'read-only': ':read-only', 'ask-for-approval': ':workspace', 'auto-review': ':workspace', 'full-access': ':danger-full-access' };
export function requestedMode(args) {
  if (args.permissionMode !== undefined && !permissionModes.includes(args.permissionMode)) throw new DispatchError('INVALID_ARGUMENT', 'Unknown permissionMode.');
  if (args.sandbox !== undefined && !['read-only', 'workspace-write'].includes(args.sandbox)) throw new DispatchError('INVALID_ARGUMENT', 'Legacy sandbox must be read-only or workspace-write.');
  const legacy = args.sandbox === 'read-only' ? 'read-only' : args.sandbox === 'workspace-write' ? 'ask-for-approval' : undefined;
  if (legacy && args.permissionMode !== undefined && args.permissionMode !== legacy) throw new DispatchError('INVALID_ARGUMENT', 'sandbox conflicts with permissionMode; use permissionMode alone.');
  return args.permissionMode ?? legacy ?? 'inherit';
}
export function permissionSettings(mode) {
  return mode === 'inherit' ? {} : { permissions: profiles[mode], approvalPolicy: mode === 'full-access' ? 'never' : 'on-request', approvalsReviewer: mode === 'auto-review' ? 'auto_review' : 'user' };
}
export function permissionSummary(value) {
  const sandbox = value?.sandboxPolicy ?? value?.sandbox;
  const sandboxType = { workspaceWrite: 'workspace-write', readOnly: 'read-only', dangerFullAccess: 'danger-full-access' }[sandbox?.type] ?? sandbox?.type ?? 'unknown';
  const approvalPolicy = value?.approvalPolicy ?? 'unknown';
  const approvalsReviewer = value?.approvalsReviewer ?? 'unknown';
  const mode = sandboxType === 'danger-full-access' && approvalPolicy === 'never' ? 'full-access'
    : approvalPolicy === 'on-request' && approvalsReviewer === 'auto_review' && sandboxType === 'workspace-write' ? 'auto-review'
    : approvalPolicy === 'on-request' && approvalsReviewer === 'user' && sandboxType === 'workspace-write' ? 'ask-for-approval'
      : approvalPolicy === 'on-request' && approvalsReviewer === 'user' && sandboxType === 'read-only' ? 'read-only' : 'custom-or-unknown';
  return { mode, approvalPolicy, approvalsReviewer, sandbox: sandboxType,
    profileId: value?.activePermissionProfile?.id ?? value?.permissions ?? null,
    networkAccess: sandboxType === 'danger-full-access' ? true : sandbox?.networkAccess ?? null };
}
export function nextPermissions(state) {
  // Thread settings updates apply to the next turn; currentPermissions can still describe the last turn.
  const current = state.currentPermissions ?? {};
  const latest = state.latestThreadSettings ?? {};
  return permissionSummary({ ...current, ...latest });
}
export function assertPermissions(state, mode) {
  const actual = nextPermissions(state);
  if (actual.sandbox === 'unknown' || actual.approvalPolicy === 'unknown' || (mode !== 'inherit' && actual.mode !== mode)) {
    throw new DispatchError('PERMISSION_MISMATCH', `Requested ${mode}; desktop reports ${actual.mode} (${actual.sandbox}, ${actual.approvalPolicy}). No task was sent. Inspect the thread permissions.`);
  }
  return actual;
}
