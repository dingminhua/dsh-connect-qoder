import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 每个测试文件拿到自己的 DSH_HOME。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 同款隔离，理由相同且对本插件更关键：本插件的 vault（
 *   `$DSH_HOME/.qoder-accounts.<region>.json`）、账号池测量
 *   （`.qoder-pool.<region>.json`）与宿主心跳（`.qoder-host-heartbeat.json`）
 *   都写在 DSH_HOME 下，且是**跨进程持久**的。共享一个 home 时，前一个文件
 *   写入的账号会被后一个文件的「扫描」当成既存资产读出来，测试之间互相污染。
 *   每个文件一个临时 home，让每个文件的账号只属于它自己。
 *
 * `setupFiles` 在每个测试文件自己的 worker 里各跑一次，所以这里对
 * `process.env` 的改动对该文件全局生效，且无需还原。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-connect-qoder-file-'))
