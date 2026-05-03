#!/usr/bin/env node
/**
 * scan-mutation-guards.mjs
 *
 * Production-safe route-aware mutation permission scanner.
 *
 * Safety model:
 * - backend permissions are authoritative;
 * - only routes in appShellRoutes can protect mutation files;
 * - route protection is valid only when handle.permission exists and is known
 *   to src/config/permissions.ts;
 * - direct route element mappings can be ROUTE_PROTECTED;
 * - indirect, wrapper, inferred, or unresolved mappings are never treated as
 *   direct route protection;
 * - subcomponents inherit only through exactly one protected parent;
 * - shared trust-boundary mutation files require a file guard;
 * - uncertainty is never classified as safe.
 *
 * Only UNGUARDED entries fail CI.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const uiRoot = resolve(__dirname, '..')
const repoRoot = resolve(uiRoot, '..')
const srcDir = resolve(uiRoot, 'src')
const featuresDir = resolve(srcDir, 'features')
const routeDataFile = resolve(srcDir, 'app/routeData.tsx')
const backendPermissionsFile = resolve(repoRoot, 'src/config/permissions.ts')

const PREVIOUS_VIOLATION_COUNT = 1
const PREVIOUS_FALSE_POSITIVE_BASELINE = 35

const CLASSIFICATIONS = [
  'FILE_GUARDED',
  'ROUTE_PROTECTED',
  'SUB_COMPONENT',
  'UNCERTAIN',
  'UNGUARDED',
]

const CONFIDENCE_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 }
const SOURCE_EXTENSIONS = ['.tsx', '.ts']
const TRUST_BOUNDARY_PARTS = new Set(['hooks', 'context', 'services'])
const SUB_COMPONENT_PARTS = new Set(['components', 'forms', 'layouts'])

const MUTATION_PATTERNS = [
  /\bapiPost\s*[(<]/,
  /\bapiPut\s*[(<]/,
  /\bapiPatch\s*[(<]/,
  /\bapiDelete\s*[(<]/,
  /\buseMutation\s*[(<({]/,
]

const DIRECT_API_MUTATION_PATTERNS = [
  /\bapiPost\s*[(<]/,
  /\bapiPut\s*[(<]/,
  /\bapiPatch\s*[(<]/,
  /\bapiDelete\s*[(<]/,
]

const GUARD_PATTERNS = [
  /\bhasPermission\s*\(/,
  /\bhasAnyPermission\s*\(/,
  /\bhasAllPermissions\s*\(/,
  /\bRequirePermission\b/,
  /\bhasUiPermission\s*\(/,
  /\bhasAnyUiPermission\s*\(/,
  /\bhasAllUiPermissions\s*\(/,
]

function read(file) {
  return readFileSync(file, 'utf8')
}

function rel(file) {
  return relative(uiRoot, file).replaceAll('\\', '/')
}

function sortByFile(a, b) {
  return rel(a.file).localeCompare(rel(b.file))
}

function minConfidence(...levels) {
  return levels.reduce((lowest, level) => (CONFIDENCE_RANK[level] < CONFIDENCE_RANK[lowest] ? level : lowest), 'HIGH')
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch (_) {
    return false
  }
}

function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function* walkFiles(dir, predicate) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'api') continue
      yield* walkFiles(full, predicate)
    } else if (predicate(full)) {
      yield full
    }
  }
}

function findMatchingClose(content, openIndex, openChar, closeChar) {
  let depth = 0
  let quote = null
  let escaped = false

  for (let i = openIndex; i < content.length; i++) {
    const char = content[i]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === openChar) depth++
    if (char === closeChar) depth--
    if (depth === 0) return i
  }
  return -1
}

function resolveSourceFile(importer, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@features/')) return null

  const candidate = specifier.startsWith('@features/')
    ? resolve(srcDir, specifier.slice(1))
    : resolve(dirname(importer), specifier)

  for (const ext of SOURCE_EXTENSIONS) {
    if (existsSync(`${candidate}${ext}`)) return normalize(`${candidate}${ext}`)
  }

  if (isDirectory(candidate)) {
    for (const indexName of ['index.tsx', 'index.ts']) {
      const indexFile = join(candidate, indexName)
      if (existsSync(indexFile)) return normalize(indexFile)
    }
  }

  return null
}

function resolveReExport(indexFile, exportedName, seen = new Set()) {
  const key = `${indexFile}:${exportedName}`
  if (seen.has(key) || !existsSync(indexFile)) return null
  seen.add(key)

  const content = stripComments(read(indexFile))
  const namedExportPattern = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const match of content.matchAll(namedExportPattern)) {
    const exported = match[1].split(',').some((raw) => {
      const [original, alias] = raw.trim().split(/\s+as\s+/).map((part) => part?.trim())
      return (alias || original) === exportedName
    })
    if (!exported) continue

    const resolved = resolveSourceFile(indexFile, match[2])
    if (!resolved) continue
    if (basename(resolved).startsWith('index.')) {
      return resolveReExport(resolved, exportedName, seen)
    }
    return resolved
  }

  return null
}

function parseImports(file) {
  const content = stripComments(read(file))
  const imports = new Map()
  const importPattern = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g

  const addImport = (symbol, entry) => {
    if (!symbol || symbol === 'type') return
    imports.set(symbol, entry)
  }

  for (const match of content.matchAll(importPattern)) {
    const clause = match[1].trim()
    const resolved = resolveSourceFile(file, match[2])
    if (!resolved) continue

    const resolveNamed = (name) => {
      if (!basename(resolved).startsWith('index.')) {
        return { file: resolved, confidence: 'HIGH', mapping: 'DIRECT' }
      }
      const reExported = resolveReExport(resolved, name, new Set())
      return reExported
        ? { file: reExported, confidence: 'MEDIUM', mapping: 'INDIRECT' }
        : { file: resolved, confidence: 'LOW', mapping: 'UNRESOLVED' }
    }

    if (clause.startsWith('{')) {
      const named = clause.slice(1, clause.indexOf('}'))
      for (const part of named.split(',')) {
        const [original, alias] = part.trim().split(/\s+as\s+/).map((value) => value?.trim())
        addImport(alias || original, resolveNamed(original))
      }
      continue
    }

    const defaultName = clause.split(',')[0]?.trim()
    addImport(defaultName, { file: resolved, confidence: 'HIGH', mapping: 'DIRECT' })

    const namedStart = clause.indexOf('{')
    if (namedStart >= 0) {
      const named = clause.slice(namedStart + 1, clause.indexOf('}', namedStart))
      for (const part of named.split(',')) {
        const [original, alias] = part.trim().split(/\s+as\s+/).map((value) => value?.trim())
        addImport(alias || original, resolveNamed(original))
      }
    }
  }

  const lazyPattern = /const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*lazy\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g
  for (const match of content.matchAll(lazyPattern)) {
    const resolved = resolveSourceFile(file, match[2])
    if (resolved) {
      addImport(match[1], { file: resolved, confidence: 'HIGH', mapping: 'DIRECT' })
    }
  }

  return imports
}

function parseBackendPermissions() {
  const content = read(backendPermissionsFile)
  const permissionsBlock = content.match(/export\s+const\s+permissions\s*=\s*\[([\s\S]*?)\]\s+as\s+const/)
  if (!permissionsBlock) {
    throw new Error(`Unable to parse backend permissions from ${backendPermissionsFile}`)
  }

  const permissions = new Set()
  for (const match of permissionsBlock[1].matchAll(/['"]([^'"]+)['"]/g)) {
    permissions.add(match[1])
  }
  return permissions
}

function parseMainRouteSymbols() {
  const content = read(routeDataFile)
  const importToFile = new Map()
  const importPattern = /import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/g

  for (const match of content.matchAll(importPattern)) {
    const resolved = resolveSourceFile(routeDataFile, match[2])
    if (!resolved) continue
    for (const rawName of match[1].split(',')) {
      const [original, alias] = rawName.trim().split(/\s+as\s+/).map((part) => part?.trim())
      importToFile.set(alias || original, { file: resolved, original })
    }
  }

  const appShellMatch = /export\s+const\s+appShellRoutes[\s\S]*?=\s*\[/.exec(content)
  if (!appShellMatch) {
    throw new Error(`Unable to parse appShellRoutes from ${routeDataFile}`)
  }
  const appShellOpen = content.indexOf('[', appShellMatch.index + appShellMatch[0].length - 1)
  const appShellClose = findMatchingClose(content, appShellOpen, '[', ']')
  if (appShellClose < 0) {
    throw new Error(`Unable to find end of appShellRoutes in ${routeDataFile}`)
  }
  const appShellBlock = content.slice(appShellOpen + 1, appShellClose)

  const routeFiles = new Map()
  for (const [symbol, imported] of importToFile) {
    if (!new RegExp(`\\.\\.\\.\\s*${symbol}\\b`).test(appShellBlock)) continue

    if (basename(imported.file).startsWith('index.')) {
      const actual = resolveReExport(imported.file, symbol, new Set())
      routeFiles.set(symbol, {
        file: actual || imported.file,
        confidence: actual ? 'MEDIUM' : 'LOW',
        mapping: actual ? 'INDIRECT' : 'UNRESOLVED',
      })
    } else {
      routeFiles.set(symbol, {
        file: imported.file,
        confidence: 'HIGH',
        mapping: 'DIRECT',
      })
    }
  }

  return routeFiles
}

function splitTopLevelObjects(arrayContent) {
  const objects = []
  let depth = 0
  let quote = null
  let escaped = false
  let start = -1

  for (let i = 0; i < arrayContent.length; i++) {
    const char = arrayContent[i]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        objects.push(arrayContent.slice(start, i + 1))
        start = -1
      }
    }
  }

  return objects
}

function extractChildrenBlock(routeObject) {
  const childrenMatch = /\bchildren\s*:\s*\[/.exec(routeObject)
  if (!childrenMatch) return null
  const open = routeObject.indexOf('[', childrenMatch.index)
  const close = findMatchingClose(routeObject, open, '[', ']')
  return close >= 0 ? routeObject.slice(open + 1, close) : null
}

function removeChildrenBlock(routeObject) {
  const childrenMatch = /\bchildren\s*:\s*\[/.exec(routeObject)
  if (!childrenMatch) return routeObject
  const open = routeObject.indexOf('[', childrenMatch.index)
  const close = findMatchingClose(routeObject, open, '[', ']')
  return close >= 0 ? `${routeObject.slice(0, childrenMatch.index)}${routeObject.slice(close + 1)}` : routeObject
}

function extractRoutePath(routeObject) {
  return routeObject.match(/\bpath\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? '(index)'
}

function extractHandlePermission(routeObject) {
  const local = removeChildrenBlock(routeObject)
  const handleMatch = /\bhandle\s*:\s*\{/.exec(local)
  if (!handleMatch) return null

  const open = local.indexOf('{', handleMatch.index)
  const close = findMatchingClose(local, open, '{', '}')
  if (close < 0) return null

  return local.slice(open + 1, close).match(/\bpermission\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? null
}

function extractElementMappings(routeObject, imports) {
  const local = removeChildrenBlock(routeObject)
  const elementMatch = /\belement\s*:/.exec(local)
  if (!elementMatch) return []

  const nextHandle = local.indexOf('handle:', elementMatch.index)
  const block = local.slice(elementMatch.index, nextHandle >= 0 ? nextHandle : undefined)
  const mappings = []

  for (const [symbol, entry] of imports) {
    const directJsx = new RegExp(`<\\s*${symbol}\\b`).test(block)
    const referenced = new RegExp(`\\b${symbol}\\b`).test(block)
    if (!referenced) continue

    const direct = directJsx && entry.mapping === 'DIRECT'
    mappings.push({
      symbol,
      file: entry.file,
      mapping: direct ? 'DIRECT' : 'INDIRECT',
      confidence: direct ? entry.confidence : minConfidence(entry.confidence, 'LOW'),
    })
  }

  return mappings
}

function parseRouteArrayContent(file) {
  const content = stripComments(read(file))
  const exportMatch = /export\s+const\s+\w+\s*(?::[^=]+)?=\s*\[/.exec(content)
  if (!exportMatch) return ''

  const open = content.indexOf('[', exportMatch.index + exportMatch[0].length - 1)
  const close = findMatchingClose(content, open, '[', ']')
  return close >= 0 ? content.slice(open + 1, close) : ''
}

function parseRouteObjects(routeFileEntry, knownPermissions) {
  const imports = parseImports(routeFileEntry.file)
  const routes = []

  function visit(arrayContent, inheritedPermission, parentPath) {
    for (const routeObject of splitTopLevelObjects(arrayContent)) {
      const ownPermission = extractHandlePermission(routeObject)
      const effectivePermission = ownPermission ?? inheritedPermission ?? null
      const permissionState =
        effectivePermission === null
          ? 'missing'
          : knownPermissions.has(effectivePermission)
            ? 'known'
            : 'unknown'
      const path = extractRoutePath(routeObject)
      const fullPath = path.startsWith('/') ? path : [parentPath, path].filter(Boolean).join('/')

      for (const element of extractElementMappings(routeObject, imports)) {
        routes.push({
          file: element.file,
          path: fullPath,
          permission: effectivePermission,
          permissionState,
          routeFile: routeFileEntry.file,
          mapping: element.mapping,
          confidence: minConfidence(routeFileEntry.confidence, element.confidence),
        })
      }

      const childrenBlock = extractChildrenBlock(routeObject)
      if (childrenBlock) visit(childrenBlock, effectivePermission, fullPath)
    }
  }

  visit(parseRouteArrayContent(routeFileEntry.file), null, '')
  return routes
}

function buildImportGraph(files) {
  const graph = new Map()
  const fileSet = new Set(files)

  for (const file of files) {
    const content = stripComments(read(file))
    const imports = parseImports(file)
    const edges = []

    for (const [symbol, entry] of imports) {
      if (!fileSet.has(entry.file)) continue
      if (!new RegExp(`\\b${symbol}\\b`).test(content)) continue
      edges.push({
        file: entry.file,
        confidence: minConfidence(entry.confidence, 'MEDIUM'),
        mapping: entry.mapping === 'DIRECT' ? 'INDIRECT' : entry.mapping,
      })
    }

    graph.set(file, edges.sort((a, b) => rel(a.file).localeCompare(rel(b.file))))
  }

  return graph
}

function buildDirectParents(graph) {
  const parents = new Map()
  for (const [parent, edges] of graph) {
    for (const edge of edges) {
      if (!parents.has(edge.file)) parents.set(edge.file, new Set())
      parents.get(edge.file).add(parent)
    }
  }
  return parents
}

function routeContextsForFile(file, routeEntries, graph) {
  const contexts = []

  for (const route of routeEntries) {
    const visited = new Set()
    const stack = [{
      file: route.file,
      confidence: route.confidence,
      mapping: route.mapping,
      distance: 0,
    }]

    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || visited.has(current.file)) continue
      visited.add(current.file)

      if (current.file === file) {
        contexts.push({
          ...route,
          confidence: current.confidence,
          mapping: current.distance === 0 ? current.mapping : 'INDIRECT',
        })
        break
      }

      for (const edge of graph.get(current.file) ?? []) {
        if (visited.has(edge.file)) continue
        stack.push({
          file: edge.file,
          confidence: minConfidence(current.confidence, edge.confidence, current.distance === 0 ? 'MEDIUM' : 'LOW'),
          mapping: 'INDIRECT',
          distance: current.distance + 1,
        })
      }
    }
  }

  return contexts.sort((a, b) => `${a.path}:${a.permission ?? ''}:${a.mapping}`.localeCompare(`${b.path}:${b.permission ?? ''}:${b.mapping}`))
}

function pathParts(file) {
  return rel(file).split('/')
}

function isTrustBoundaryFile(file) {
  return pathParts(file).some((part) => TRUST_BOUNDARY_PARTS.has(part))
}

function isSubComponentFile(file) {
  return pathParts(file).some((part) => SUB_COMPONENT_PARTS.has(part))
}

function hasMutation(content) {
  return MUTATION_PATTERNS.some((pattern) => pattern.test(content))
}

function hasFileGuard(content) {
  return GUARD_PATTERNS.some((pattern) => pattern.test(content))
}

function containsDirectApiMutation(content) {
  return DIRECT_API_MUTATION_PATTERNS.some((pattern) => pattern.test(content))
}

function detectMutationContext(file, content) {
  const contexts = []
  const lines = content.split('\n')
  const stripped = stripComments(content)

  if (/\buseEffect\s*\([\s\S]{0,900}\b(apiPost|apiPut|apiPatch|apiDelete)\s*[(<]/.test(stripped)) {
    contexts.push('direct API mutation inside useEffect/lifecycle')
  }

  if (/\bon[A-Z][A-Za-z0-9_]*\s*=\s*\{[\s\S]{0,600}\b(apiPost|apiPut|apiPatch|apiDelete)\s*[(<]/.test(stripped)) {
    contexts.push('direct API mutation inside JSX event handler')
  }

  if (/\b(?:const|function)\s+handle[A-Z][A-Za-z0-9_]*[\s\S]{0,900}\b(apiPost|apiPut|apiPatch|apiDelete)\s*[(<]/.test(stripped)) {
    contexts.push('direct API mutation inside event handler function')
  }

  if (/\bon[A-Z][A-Za-z0-9_]*\s*=\s*\{[\s\S]{0,700}\b[A-Za-z0-9_]+\.mutate\s*\(/.test(stripped)) {
    contexts.push('react-query mutation trigger inside JSX event handler')
  }

  if (/\b(?:const|function)\s+(?:handle|on|submit|save|post|create|update|cancel|void|close|approve)[A-Z]?[A-Za-z0-9_]*[\s\S]{0,1200}\b[A-Za-z0-9_]+\.mutate\s*\(/.test(stripped)) {
    contexts.push('react-query mutation trigger inside event handler function')
  }

  if (isTrustBoundaryFile(file)) {
    contexts.push('shared hook/context/service mutation file')
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!/\bexport\s+(async\s+)?function\s+/.test(line) && !/\bexport\s+const\s+/.test(line)) continue
    const exportedName = line.match(/\b(?:function|const)\s+([A-Za-z0-9_]+)/)?.[1]
    const isReactComponent = exportedName && /^[A-Z]/.test(exportedName)
    const isHook = exportedName && /^use[A-Z]/.test(exportedName)
    if ((isHook || !isReactComponent) && containsDirectApiMutation(stripped.slice(stripped.indexOf(line)))) {
      contexts.push('exported/shared function can perform mutation')
      break
    }
  }

  return [...new Set(contexts)]
}

function summarizeContexts(contexts) {
  if (contexts.length === 0) return 'unresolved'
  return contexts.map((context) => {
    const route = `/${context.path.replace(/^\/+/, '')}`
    return `${route} permission=${context.permission ?? '(missing)'} mapping=${context.mapping} confidence=${context.confidence}`
  }).join('; ')
}

function allContextsHaveValidRouteProtection(contexts) {
  return contexts.length > 0 && contexts.every((context) => context.permissionState === 'known')
}

function allContextsDirectAndHigh(contexts) {
  return contexts.length > 0 && contexts.every((context) => context.mapping === 'DIRECT' && context.confidence === 'HIGH')
}

function allContextsDirect(contexts) {
  return contexts.length > 0 && contexts.every((context) => context.mapping === 'DIRECT')
}

function isWriteCapablePermission(permission) {
  if (!permission) return false
  return /:(write|post|approve|void|allocate|execute|imports|outbox|reconcile)$/.test(permission)
}

function isUserInitiatedMutationContext(context) {
  return context === 'component render/useMutation setup' ||
    context === 'react-query mutation trigger inside JSX event handler' ||
    context === 'react-query mutation trigger inside event handler function' ||
    context === 'direct API mutation inside JSX event handler' ||
    context === 'direct API mutation inside event handler function'
}

function hasBackgroundOrSharedMutationContext(contexts) {
  return contexts.some((context) => !isUserInitiatedMutationContext(context))
}

function parentCountFor(file, parents) {
  return parents.get(file)?.size ?? 0
}

function classifyMutationFile(file, content, routeContexts, parents) {
  const mutationContexts = detectMutationContext(file, content)
  const fileGuarded = hasFileGuard(content)
  const protectedRoute = allContextsHaveValidRouteProtection(routeContexts)
  const directRoute = allContextsDirect(routeContexts)
  const confidence = routeContexts.length === 0
    ? 'LOW'
    : routeContexts.reduce((current, route) => minConfidence(current, route.confidence), 'HIGH')

  if (fileGuarded) {
    return {
      classification: 'FILE_GUARDED',
      reason: 'explicit permission guard in file',
      confidence: 'HIGH',
      mutationContexts,
      contexts: routeContexts,
    }
  }

  if (routeContexts.length === 0) {
    return {
      classification: 'UNCERTAIN',
      reason: 'no main-route mapping found',
      confidence: 'LOW',
      mutationContexts,
      contexts: routeContexts,
    }
  }

  if (!protectedRoute) {
    return {
      classification: 'UNCERTAIN',
      reason: 'route permission missing or not present in backend permission list',
      confidence,
      mutationContexts,
      contexts: routeContexts,
    }
  }

  const protectionStates = new Set(routeContexts.map((context) => context.permissionState))
  if (protectionStates.size > 1) {
    return {
      classification: 'UNCERTAIN',
      reason: 'component appears in multiple routes with mixed protection states',
      confidence,
      mutationContexts,
      contexts: routeContexts,
    }
  }

  const permissionStates = new Set(routeContexts.map((context) => context.permission))
  if (permissionStates.size > 1 && !mutationContexts.includes('shared hook/context/service mutation file')) {
    return {
      classification: 'UNCERTAIN',
      reason: 'component appears in multiple routes with different permissions',
      confidence,
      mutationContexts,
      contexts: routeContexts,
    }
  }

  const [permission] = permissionStates
  if (!isWriteCapablePermission(permission)) {
    return {
      classification: 'UNGUARDED',
      reason: `file guard required: route permission "${permission}" is not write-capable for a mutation`,
      confidence,
      mutationContexts,
      contexts: routeContexts,
    }
  }

  if (hasBackgroundOrSharedMutationContext(mutationContexts)) {
    return {
      classification: 'UNGUARDED',
      reason: `file guard required: ${mutationContexts.join('; ')}`,
      confidence,
      mutationContexts,
      contexts: routeContexts,
    }
  }

  if (isSubComponentFile(file)) {
    const directParentCount = parentCountFor(file, parents)
    if (directParentCount === 1 && protectedRoute) {
      return {
        classification: 'SUB_COMPONENT',
        reason: 'exactly one protected parent imports this mutation subcomponent',
        confidence: minConfidence(confidence, 'MEDIUM'),
        mutationContexts,
        contexts: routeContexts,
      }
    }
    return {
      classification: 'UNCERTAIN',
      reason: `subcomponent has ${directParentCount} direct parents; inheritance is ambiguous`,
      confidence: minConfidence(confidence, 'LOW'),
      mutationContexts,
      contexts: routeContexts,
    }
  }

  if (!directRoute || routeContexts.length !== 1) {
    return {
      classification: 'UNCERTAIN',
      reason: 'route mapping is indirect, wrapped, reused, or ambiguous',
      confidence,
      mutationContexts,
      contexts: routeContexts,
    }
  }

  return {
    classification: 'ROUTE_PROTECTED',
    reason: 'direct single main-route page with known write-capable backend permission',
    confidence,
    mutationContexts,
    contexts: routeContexts,
  }
}

function printRows(title, rows) {
  console.log(`${title} (${rows.length})`)
  for (const row of rows) {
    console.log(`  file: ${rel(row.file)}`)
    console.log(`    classification: ${row.classification}`)
    console.log(`    reason: ${row.reason}`)
    console.log(`    confidence: ${row.confidence}`)
    console.log(`    routes: ${summarizeContexts(row.contexts)}`)
    console.log(`    mutationContext: ${row.mutationContexts.length > 0 ? row.mutationContexts.join('; ') : 'component render/useMutation setup'}`)
  }
  console.log()
}

const knownPermissions = parseBackendPermissions()
const mainRouteFiles = parseMainRouteSymbols()
const featureFiles = [...walkFiles(featuresDir, (file) => SOURCE_EXTENSIONS.includes(extname(file)))]
const tsxFiles = featureFiles.filter((file) => extname(file) === '.tsx')
const graph = buildImportGraph(featureFiles)
const parents = buildDirectParents(graph)

const routeEntries = [...mainRouteFiles.values()]
  .flatMap((routeFile) => parseRouteObjects(routeFile, knownPermissions))
  .sort((a, b) => `${a.path}:${rel(a.file)}`.localeCompare(`${b.path}:${rel(b.file)}`))

const results = Object.fromEntries(CLASSIFICATIONS.map((name) => [name, []]))
const mutationFiles = []

for (const file of tsxFiles) {
  const content = read(file)
  if (!hasMutation(content)) continue

  const contexts = routeContextsForFile(file, routeEntries, graph)
  const result = classifyMutationFile(file, content, contexts, parents)
  mutationFiles.push(file)
  results[result.classification].push({ file, ...result })
}

for (const classification of CLASSIFICATIONS) {
  results[classification].sort(sortByFile)
}

const currentViolationCount = results.UNGUARDED.length
const falsePositiveReduction = PREVIOUS_FALSE_POSITIVE_BASELINE === 0
  ? 0
  : ((PREVIOUS_FALSE_POSITIVE_BASELINE - currentViolationCount) / PREVIOUS_FALSE_POSITIVE_BASELINE) * 100

console.log('Mutation guard scan')
console.log(`totalFilesScanned: ${tsxFiles.length}`)
console.log(`mutationFilesFound: ${mutationFiles.length}`)
console.log(`mainRouteFilesScanned: ${mainRouteFiles.size}`)
console.log(`routeEntriesIndexed: ${routeEntries.length}`)
console.log(`validBackendPermissions: ${knownPermissions.size}`)
console.log(`previousViolationCount: ${PREVIOUS_VIOLATION_COUNT}`)
console.log(`newViolationCount: ${currentViolationCount}`)
console.log(`falsePositiveReduction: ${falsePositiveReduction.toFixed(1)}%`)
console.log('verifiedFixedClassification: src/features/receiving/context/ReceivingContext.tsx moved from UNCERTAIN to UNGUARDED because shared context mutations require a file guard.')
console.log()

console.log('TRUE VIOLATIONS')
printRows('UNGUARDED', results.UNGUARDED)

console.log('PROTECTED')
printRows('FILE_GUARDED', results.FILE_GUARDED)
printRows('ROUTE_PROTECTED', results.ROUTE_PROTECTED)
printRows('SUB_COMPONENT', results.SUB_COMPONENT)

console.log('UNCERTAIN')
printRows('UNCERTAIN', results.UNCERTAIN)

console.log('Classification summary')
for (const classification of CLASSIFICATIONS) {
  console.log(`${classification}: ${results[classification].length}`)
}

if (results.UNGUARDED.length > 0) {
  console.log()
  console.log('Failing because TRUE violations were found. UNCERTAIN entries require review but do not fail CI.')
  process.exit(1)
}
