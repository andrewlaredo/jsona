import type { SupportedFormat } from 'jsona-core';

export interface SampleDoc {
  id: string;
  /** i18n key for the sample button label (zh-CN / en). */
  labelKey: string;
  format: SupportedFormat;
  text: string;
}

/**
 * Built-in demo documents shown on the empty state. Each covers a different
 * format so a single click exercises parsing + every secondary view.
 */
export const SAMPLES: SampleDoc[] = [
  {
    id: 'users',
    labelKey: 'sample.users',
    format: 'json',
    text: `{
  "users": [
    { "id": 1, "name": "Ada Lovelace", "role": "admin", "active": true, "tags": ["founder", "math"] },
    { "id": 2, "name": "Alan Turing", "role": "engineer", "active": true, "tags": ["crypto"] },
    { "id": 3, "name": "Grace Hopper", "role": "engineer", "active": false, "tags": ["compiler"] }
  ],
  "meta": { "total": 3, "generatedAt": "2026-08-14", "nested": { "deep": { "value": 42 } } }
}`,
  },
  {
    id: 'config',
    labelKey: 'sample.config',
    format: 'yaml',
    text: `server:
  host: 0.0.0.0
  port: 8080
  tls:
    enabled: true
    cert: /etc/ssl/cert.pem
features:
  - search
  - export
  - webhook
limits:
  maxItems: 1000
  timeout: 30`,
  },
  {
    id: 'table',
    labelKey: 'sample.table',
    format: 'csv',
    text: `id,name,department,salary,remote
1,Linus Torvalds,Kernel,120000,false
2,Margaret Hamilton,Guidance,135000,true
3,Dennis Ritchie,Systems,98000,false
4,Barbara Liskov,Distributed,142000,true`,
  },
  {
    id: 'toml',
    labelKey: 'sample.toml',
    format: 'toml',
    text: `[package]
name = "jsona"
version = "1.0.0"
edition = "2026"

[dependencies]
monaco = "0.52"
react = "19"

[features]
default = ["tree", "graph"]`,
  },
];
