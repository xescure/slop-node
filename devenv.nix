{ pkgs, ... }:

{
  packages = [ pkgs.nodejs_24 pkgs.gnumake pkgs.jq pkgs.git pkgs.gnupatch ];
}
