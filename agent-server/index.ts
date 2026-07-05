// Role-split entrypoint (dispatch-layering, group D1). One deployed bundle serves
// two roles selected by argv:
//   --role=exec (default / today's behaviour) → the per-session executor (exec.ts),
//     which statically imports the providers + their SDKs.
//   --role=dispatcher → the thin per-host broker (dispatcher.ts).
//
// The role modules are loaded via DYNAMIC import so the provider/SDK code in exec.ts
// only initializes when the exec role is chosen → the dispatcher process stays THIN
// (never loads the SDKs) even though both roles ship in one bundle. See the
// dispatch-layering SDD ("One bundle, role by argv").
const roleArg = process.argv.find((a) => a.startsWith('--role='));
const role = roleArg ? roleArg.split('=')[1] : 'exec';

if (role === 'dispatcher') {
  void import('./dispatcher').then((m) => m.runDispatcher());
} else {
  // Side-effect import: exec.ts runs its setup on load (only in the exec role).
  void import('./exec');
}
