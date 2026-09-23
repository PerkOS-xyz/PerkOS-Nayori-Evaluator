alter table evaluations
  drop constraint if exists evaluations_network_check;

alter table evaluations
  add constraint evaluations_network_check
  check (network in ('testnet', 'mainnet')) not valid;

alter table evaluations
  validate constraint evaluations_network_check;
