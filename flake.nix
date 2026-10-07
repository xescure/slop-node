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
        image = pkgsBySystem.${system}.callPackage ./nix/image.nix {
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
        devenvLock = nixpkgs.lib.importJSON ./devenv.lock;
        nixpkgsRev = nixpkgs.rev;
      });
    };
}
