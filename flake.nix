{
  description = "slop-node, a Keeta network node";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nix2container }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = function: nixpkgs.lib.genAttrs systems function;
      # The node and its client are under the Keeta Token Network Community
      # License, which nixpkgs counts as unfree; nothing else is let through.
      pkgsBySystem = forAllSystems (system: import nixpkgs {
        inherit system;
        config.allowUnfreePredicate = package: nixpkgs.lib.getName package == "slop-node";
      });
    in
    {
      packages = forAllSystems (system: {
        default = pkgsBySystem.${system}.callPackage ./nix/package.nix { };
        image = pkgsBySystem.${system}.callPackage ./nix/image.nix {
          inherit (nix2container.packages.${system}) nix2container;
          slop-node = self.packages.${system}.default;
          revision = self.rev or null;
        };
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.default;
          meta.description = "Runs the slop-node command";
        };
      });

      checks = forAllSystems (system: import ./nix/checks.nix {
        pkgs = pkgsBySystem.${system};
        slop-node = self.packages.${system}.default;
        image = self.packages.${system}.image;
        inherit (nix2container.packages.${system}) skopeo-nix2container;
      });

      # The tools the Makefile and the tests run, from the same nixpkgs as the
      # package, so they run on the Node and Postgres the image ships with. The
      # tests, the follower and the devnet start their own Postgres clusters
      # from these binaries; nothing needs a server running beside the shell.
      devShells = forAllSystems (system:
        let
          pkgs = pkgsBySystem.${system};
        in
        {
          default = pkgs.mkShell {
            inputsFrom = [ self.packages.${system}.default ];
            packages = [
              pkgs.nodejs_24
              pkgs.gnumake
              pkgs.jq
              pkgs.git
              pkgs.gnupatch
              pkgs.openssl
              (pkgs.lib.getBin pkgs.postgresql_18)
            ];
          };
        });
    };
}
