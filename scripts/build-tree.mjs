// Regenerate the web tree JSON from PoB's tree.lua via LuaJIT.
//   node scripts/build-tree.mjs [version]   (default 0_5)
// Override LuaJIT/PoB locations with POB_LUAJIT / POB_SRC (same as the engine).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const version = process.argv[2] || "0_5";
const luajit =
  process.env.POB_LUAJIT ||
  join(process.env.LOCALAPPDATA || "", "Programs", "LuaJIT", "bin", "luajit.exe");
const pobSrc = process.env.POB_SRC || join(".vendor", "PathOfBuilding-PoE2", "src");
const treeLua = join(pobSrc, "TreeData", version, "tree.lua");
const out = join("public", `tree-${version}.json`);

console.log(`Converting ${treeLua} -> ${out}`);
const r = spawnSync(luajit, ["scripts/tree_to_json.lua", treeLua, out], { stdio: "inherit" });
if (r.error) {
  console.error(`Failed to run LuaJIT (${luajit}):`, r.error.message);
  console.error("Set POB_LUAJIT / POB_SRC, or install LuaJIT + vendor PathOfBuilding-PoE2.");
}
process.exit(r.status ?? 1);
