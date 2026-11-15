import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const webRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(webRoot, '.tmp-test-dist');

function collectTsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

function rewriteAliasRequires(jsCode, compiledFilePath) {
  const compiledDir = path.dirname(compiledFilePath);
  const compiledSrcRoot = path.join(outDir, 'src');

  return jsCode.replace(/require\((['"])@\/([^'"]+)\1\)/g, (_m, quote, target) => {
    const absTarget = path.join(compiledSrcRoot, target);
    let rel = path.relative(compiledDir, absTarget).replaceAll(path.sep, '/');
    if (!rel.startsWith('.')) {
      rel = `./${rel}`;
    }
    return `require(${quote}${rel}${quote})`;
  });
}

function compileTree(sourceDir, targetSubdir) {
  if (!fs.existsSync(sourceDir)) return [];
  const files = collectTsFiles(sourceDir);
  const compiledPaths = [];

  for (const file of files) {
    const rel = path.relative(sourceDir, file);
    const outFile = path.join(outDir, targetSubdir, rel.replace(/\.(ts|tsx)$/, '.js'));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });

    const sourceText = fs.readFileSync(file, 'utf8');
    const result = ts.transpileModule(sourceText, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: true,
        skipLibCheck: true,
      },
      reportDiagnostics: true,
    });

    if (result.diagnostics && result.diagnostics.length > 0) {
      const msg = ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
        getCurrentDirectory: () => webRoot,
        getCanonicalFileName: (f) => f,
        getNewLine: () => '\n',
      });
      throw new Error(`TypeScript transpile error in ${file}:\n${msg}`);
    }

    const rewritten = rewriteAliasRequires(result.outputText, outFile);
    fs.writeFileSync(outFile, rewritten, 'utf8');
    compiledPaths.push(outFile);
  }

  return compiledPaths;
}

fs.rmSync(outDir, { recursive: true, force: true });

try {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8');

  compileTree(path.join(webRoot, 'src', 'types'), 'src/types');
  compileTree(path.join(webRoot, 'src', 'lib'), 'src/lib');
  const testFiles = compileTree(path.join(webRoot, 'tests'), 'tests')
    .filter((f) => f.endsWith('.test.js'));

  if (testFiles.length === 0) {
    throw new Error('No compiled test files found under apps/web/tests');
  }

  const run = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: webRoot,
    stdio: 'inherit',
  });

  process.exitCode = run.status ?? 1;
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
