create table if not exists evaluations (
  id uuid primary key,
  network text not null check (network = 'testnet'),
  asset text not null check (asset in ('stx', 'sbtc')),
  contract_id text not null,
  job_id numeric(39, 0) not null,
  status text not null check (
    status in ('queued', 'leased', 'blocked', 'approved', 'broadcast', 'confirmed')
  ),
  request_json jsonb not null,
  public_artifact jsonb,
  private_payload_ciphertext bytea,
  blocked_reason text,
  txid text,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network, contract_id, job_id)
);

create index if not exists evaluations_status_updated_idx
  on evaluations (status, updated_at);

revoke insert, update, delete, truncate on evaluations from public;
