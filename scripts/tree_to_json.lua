-- One-time converter: PoB tree.lua -> compact tree JSON for the web renderer.
--   luajit scripts/tree_to_json.lua <tree.lua> <out.json>
-- Emits { minX,minY,maxX,maxY, nodes:[{id,x,y,n?,k?,t?,c?}] } with precomputed
-- positions (group + orbitRadii + orbitAnglesByOrbit) and connections (c).

local treePath, outPath = arg[1], arg[2]
local tree = dofile(treePath)
local C = tree.constants
local radii = C.orbitRadii
local angById = C.orbitAnglesByOrbit
local groups = tree.groups

local function getGroup(gid)
  return groups[gid] or groups[tostring(gid)] or groups[tonumber(gid)]
end

local function pos(node)
  local g = getGroup(node.group)
  if not g then return nil end
  local orbit = node.orbit or 0
  if orbit == 0 then return g.x, g.y end
  local r = radii[orbit] or radii[orbit + 1]
  local angles = angById[orbit] or angById[orbit + 1]
  if not r or not angles then return g.x, g.y end
  local a = angles[(node.orbitIndex or 0) + 1] or angles[node.orbitIndex or 0] or 0
  return g.x + r * math.sin(a), g.y - r * math.cos(a)
end

local function jstr(s)
  return '"' .. tostring(s):gsub('[%z\1-\31\\"]', function(c)
    local m = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
    return m[c] or string.format("\\u%04x", string.byte(c))
  end) .. '"'
end
local function jnum(n)
  if n % 1 == 0 then return string.format("%d", n) end
  return string.format("%.1f", n)
end

local out, n = {}, 0
local minx, miny, maxx, maxy = 1e18, 1e18, -1e18, -1e18
for id, node in pairs(tree.nodes) do
  local nid = tonumber(node.skill) or tonumber(id)
  if nid and node.group and node.orbit ~= nil and not node.isProxy then
    local x, y = pos(node)
    if x then
      if x < minx then minx = x end
      if x > maxx then maxx = x end
      if y < miny then miny = y end
      if y > maxy then maxy = y end
      local parts = { '{"id":' .. jnum(nid) .. ',"x":' .. jnum(x) .. ',"y":' .. jnum(y) }
      if node.isKeystone then parts[#parts + 1] = ',"k":1' end
      if node.isNotable then parts[#parts + 1] = ',"t":1' end
      if node.name and node.name ~= "" then parts[#parts + 1] = ',"n":' .. jstr(node.name) end
      if type(node.stats) == "table" then
        local sd = {}
        for _, line in ipairs(node.stats) do
          if type(line) == "string" and line ~= "" then sd[#sd + 1] = jstr(line) end
        end
        if #sd > 0 then parts[#parts + 1] = ',"d":[' .. table.concat(sd, ",") .. "]" end
      end
      local cs = {}
      if type(node.connections) == "table" then
        for _, conn in pairs(node.connections) do
          local cid = tonumber(type(conn) == "table" and (conn.id or conn.nodeId) or conn)
          if cid then cs[#cs + 1] = jnum(cid) end
        end
      end
      if #cs > 0 then parts[#parts + 1] = ',"c":[' .. table.concat(cs, ",") .. "]" end
      parts[#parts + 1] = "}"
      n = n + 1
      out[n] = table.concat(parts)
    end
  end
end

local f = assert(io.open(outPath, "w"))
f:write('{"minX":' .. jnum(minx) .. ',"minY":' .. jnum(miny) .. ',"maxX":' .. jnum(maxx) .. ',"maxY":' .. jnum(maxy) .. ',"nodes":[')
f:write(table.concat(out, ","))
f:write("]}")
f:close()
io.stderr:write(string.format("nodes=%d bounds=(%d,%d)..(%d,%d)\n", n, minx, miny, maxx, maxy))
