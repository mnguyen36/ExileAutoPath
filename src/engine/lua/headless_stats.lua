-- ExileAutoPath headless stat bridge.
--
-- Boots Path of Building 2 headless (no GUI) and dumps a build's computed stats
-- as JSON. Designed to be spawned by src/engine/pob.ts.
--
-- Run with cwd = <PathOfBuilding-PoE2>/src
--   luajit headless_stats.lua <input-build.xml> <output-stats.json>
--   luajit headless_stats.lua --new <output-stats.json>   (empty build; boot test)
--
-- We feed XML (not a compressed import code): HeadlessWrapper stubs Deflate/
-- Inflate to "", so code decoding is done on the Node side and the XML handed in.

-- Mirror .busted's lpath so PoB's bundled Lua libs (dkjson, xml, sha1, …) resolve,
-- and add the Windows runtime dir to cpath for native modules (lua-utf8.dll, etc.).
-- The DLLs are PoB's, built against LuaJIT 2.1 (lua51.dll), ABI-compatible with this
-- interpreter; require('lua-utf8') loads lua-utf8.dll / symbol luaopen_utf8.
package.path = "../runtime/lua/?.lua;../runtime/lua/?/init.lua;" .. package.path
package.cpath = "../runtime/?.dll;" .. package.cpath

local inPath = arg[1]
local outPath = arg[2]

-- Boot PoB headless. Defines globals: build, newBuild, loadBuildFromXML, runCallback.
-- (If startup fails, the wrapper prints promptMsg and calls io.read; the parent
-- spawns us with stdin closed so that returns immediately instead of hanging.)
dofile("HeadlessWrapper.lua")

local loadOk, loadErr = true, nil
if inPath == "--new" then
  if newBuild then newBuild() else loadOk = false; loadErr = "newBuild() unavailable" end
else
  local f = io.open(inPath, "r")
  if not f then
    loadOk, loadErr = false, "could not open input: " .. tostring(inPath)
  else
    local xml = f:read("*a"); f:close()
    loadOk, loadErr = pcall(function() loadBuildFromXML(xml) end)
    if loadOk then runCallback("OnFrame") end -- ensure a recalculation pass
  end
end

-- ---------------------------------------------------------------------------
-- Collect scalar stats from the calc output tables.
-- ---------------------------------------------------------------------------
local function collectScalars(dst, src)
  if type(src) ~= "table" then return end
  for k, v in pairs(src) do
    if type(k) == "string" then
      local tv = type(v)
      if tv == "number" then
        if v == v and v ~= math.huge and v ~= -math.huge then dst[k] = v end
      elseif tv == "boolean" then
        dst[k] = v
      end
    end
  end
end

local stats = {}
if build and build.calcsTab then
  collectScalars(stats, build.calcsTab.calcsOutput) -- includes *MaximumHitTaken; lower priority
  collectScalars(stats, build.calcsTab.mainOutput)  -- display stats; wins on key conflicts
end

-- ---------------------------------------------------------------------------
-- Minimal JSON encoder for a flat map of string -> number|boolean.
-- ---------------------------------------------------------------------------
local function jsonEscape(s)
  return (s:gsub('[%z\1-\31\\"]', function(c)
    local map = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
    return map[c] or string.format("\\u%04x", string.byte(c))
  end))
end
local function jsonNumber(n)
  if n % 1 == 0 and math.abs(n) < 1e15 then return string.format("%d", n) end
  return string.format("%.6g", n)
end

local parts = {}
for k, v in pairs(stats) do
  local val = (type(v) == "boolean") and tostring(v) or jsonNumber(v)
  parts[#parts + 1] = '"' .. jsonEscape(k) .. '":' .. val
end

local fields = {}
fields[#fields + 1] = '"ok":' .. tostring(loadOk and build ~= nil)
if not loadOk then
  fields[#fields + 1] = '"error":"' .. jsonEscape(tostring(loadErr)) .. '"'
elseif not build then
  fields[#fields + 1] = '"error":"PoB failed to initialise (no build object)"'
end
fields[#fields + 1] = '"statCount":' .. #parts
fields[#fields + 1] = '"stats":{' .. table.concat(parts, ",") .. '}'

local out = assert(io.open(outPath, "w"))
out:write("{" .. table.concat(fields, ",") .. "}")
out:close()
