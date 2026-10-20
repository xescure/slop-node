{
  description = "slop-node, a Keeta network node";

  # The same nixpkgs as devenv.lock, so the package runs on the Node and
  # Postgres the tests run on; the nixpkgs-pin check holds the two together.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
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
        # The node's own default is any free port on 127.0.0.1, which nothing
        # outside a container reaches; the image listens on every interface, at
        # a port it can declare.
        image = pkgsBySystem.${system}.callPackage ./nix/image.nix {
          slop-node = self.packages.${system}.default;
          name = "slop-node";
          description = self.packages.${system}.default.meta.description;
          program = "slop-node";
          cmd = [ "run" ];
          env = [
            "KEETANET_LOCAL_NODE_LISTEN_IP=0.0.0.0"
            "KEETANET_LOCAL_NODE_LISTEN_PORT=8080"
          ];
          port = 8080;
          stateDirectory = "/var/lib/slop-node";
          revision = self.rev or null;
        };
        # The explorer keeps no state of its own: everything it holds is in
        # the database.
        explorer-image = pkgsBySystem.${system}.callPackage ./nix/image.nix {
          slop-node = self.packages.${system}.default;
          name = "slop-explorer";
          description = "An explorer of a Keeta network node's ledger, served over MCP";
          program = "slop-explorer";
          env = [
            "SLOP_EXPLORER_LISTEN_IP=0.0.0.0"
            "SLOP_EXPLORER_LISTEN_PORT=8080"
          ];
          port = 8080;
          revision = self.rev or null;
        };
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.default;
          meta.description = "Runs the slop-node command";
        };
        explorer = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/slop-explorer";
          meta.description = "Runs the slop-explorer command";
        };
      });

      checks = forAllSystems (system: import ./nix/checks.nix {
        pkgs = pkgsBySystem.${system};
        slop-node = self.packages.${system}.default;
        image = self.packages.${system}.image;
        explorerImage = self.packages.${system}.explorer-image;
        devenvLock = nixpkgs.lib.importJSON ./devenv.lock;
        nixpkgsRev = nixpkgs.rev;
      });
    };
}
