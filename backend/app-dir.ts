// The application's deployment directory: the folder holding `dist/`,
// `static/` and (unless KIKO_DATA_DIR says otherwise) the data folders.
//
// In the source tree that is `backend/`. The esbuild bundle inlines this module
// into `build/`, and its output is flat (entry points and shared chunks side by
// side), so a bundled run resolves it to `build/`. Either way it is the
// directory the app was deployed into, which is what every path previously
// derived from __dirname really meant. See the TypeScript migration design,
// docs/superpowers/specs/2026-11-09-typescript-migration-design.md §5.5.
export const appDir: string = import.meta.dirname;
