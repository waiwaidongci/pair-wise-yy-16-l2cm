#!/usr/bin/env node
// 编译并运行 store 端到端验证
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('.store-check', { recursive: true })
writeFileSync('.store-check/package.json', JSON.stringify({ type: 'commonjs' }))
execSync(
  'node_modules/.bin/tsc scripts/store-check.ts --outDir .store-check --module commonjs '
  + '--target es2022 --moduleResolution node --skipLibCheck --esModuleInterop',
  { stdio: 'inherit', cwd: process.cwd() },
)
execSync('node .store-check/scripts/store-check.js', { stdio: 'inherit', cwd: process.cwd() })
