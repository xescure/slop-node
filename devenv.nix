{ pkgs, lib, ... }:

let
  # The newest stable major in the pinned nixpkgs. The tests start their own
  # cluster from these binaries, so the service below is never needed by them.
  postgresql = pkgs.postgresql_18;
in
{
  packages = [ pkgs.nodejs_24 pkgs.gnumake pkgs.jq pkgs.git pkgs.gnupatch (lib.getBin postgresql) ];

  services.postgres = {
    enable = true;
    package = postgresql;
  };
}
