{
  pkgs,
  slop-node,
  devenvLock,
  nixpkgsRev,
}:

let
  inherit (pkgs) lib;

  root = "${slop-node}/${slop-node.installRoot}";

  # The representative seed of src/testing/network.ts and the public key of its
  # trusted-root seed: test keys only.
  testNode = ''
    export KEETANET_LOCAL_NODE_SEED=0b7e3a91c4d85f26e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8
    export KEETANET_INITIAL_TRUSTED_ACCOUNT=keeta_aabyvwulmd2q6qtkkd42b4d63a4xcyckeisuknsvywmmbnkypguljzyla42as5q
    export KEETANET_LOCAL_NODE_NETWORK=local
    export KEETANET_LOCAL_NODE_LISTEN_PORT=0
  '';

  # The node prints its API URL once it serves, so its output is read through a
  # FIFO up to that line, rather than polled. A node that has stopped serving
  # closes the FIFO, which bounds the wait for its exit.
  serveThenStop = ''
    fail() {
      echo "$*" >&2
      cat node.stderr >&2
      exit 1
    }

    serve_then_stop() {
      mkfifo node.stdout
      slop-node run >node.stdout 2>node.stderr &
      node=$!
      exec 3<node.stdout

      api=
      while IFS= read -r -t 60 line <&3; do
        echo "$line"
        case $line in
          'api: '*)
            api=''${line#api: }
            break
            ;;
        esac
      done
      [ -n "$api" ] || fail "the node did not serve"

      version=$(curl --fail --silent --show-error "$api/node/version" | jq --raw-output .node)
      [ "$version" = "${slop-node.version}+slop-node" ] || fail "the node reported the version $version"
      echo "GET $api/node/version: $version"

      kill -TERM "$node"
      timeout 20 cat <&3 >node.stopping || fail "the node did not stop within 20 s of SIGTERM"
      cat node.stopping
      status=0
      wait "$node" || status=$?
      [ "$status" -eq 0 ] || fail "the node exited with $status after SIGTERM"
      grep --quiet --line-regexp 'stopping on SIGTERM' node.stopping || fail "the node did not report stopping on SIGTERM"
    }
  '';

  nodeCheck = name: inputs: script:
    pkgs.runCommand "slop-node-check-${name}" { nativeBuildInputs = [ slop-node ] ++ inputs; } ''
      set -euo pipefail
      ${script}
      touch $out
    '';
in
{
  help = nodeCheck "help" [ ] ''
    slop-node --help >usage
    grep --quiet '^Usage: slop-node <command>$' usage
  '';

  run-memory = nodeCheck "run-memory" [ pkgs.curl pkgs.jq ] ''
    ${testNode}
    ${serveThenStop}
    serve_then_stop
  '';

  # The ledger in Postgres over a Unix socket: the node migrates it from the
  # installed schema/migrations, whose files the recorded digests must match.
  run-postgres = nodeCheck "run-postgres" [ pkgs.curl pkgs.jq pkgs.postgresql_18 ] ''
    ${testNode}
    ${serveThenStop}

    socket=$TMPDIR/postgres
    mkdir "$socket"
    initdb --pgdata="$TMPDIR/data" --username=slop --auth=trust --no-locale --encoding=UTF8 >/dev/null
    pg_ctl --pgdata="$TMPDIR/data" --log="$TMPDIR/postgres.log" --wait \
      --options="-c listen_addresses= -c unix_socket_directories=$socket" start
    createdb --host="$socket" --username=slop ledger
    export KEETANET_LOCAL_NODE_POSTGRES_URL="postgresql://slop@''${socket//\//%2F}/ledger"

    serve_then_stop

    for migration in ${root}/schema/migrations/*.sql; do
      name=$(basename "$migration")
      digest=$(sha256sum <"$migration")
      echo "$((10#''${name%%_*})) ''${digest%% *}"
    done >expected
    psql --host="$socket" --username=slop --dbname=ledger --no-align --tuples-only \
      --command="SELECT version || ' ' || encode(sha256, 'hex') FROM schema_version ORDER BY version" >applied
    pg_ctl --pgdata="$TMPDIR/data" --wait stop
    echo "schema_version:"
    cat applied
    [ -s expected ] || fail "no migrations installed in ${root}/schema/migrations"
    cmp expected applied
  '';

  # Everything the package needs at runtime beyond itself is Node's.
  closure = pkgs.runCommand "slop-node-check-closure" {
    package = pkgs.closureInfo { rootPaths = [ slop-node ]; };
    nodejs = pkgs.closureInfo { rootPaths = [ slop-node.nodejs ]; };
  } ''
    comm -23 $package/store-paths $nodejs/store-paths >extra
    echo ${slop-node} | cmp - extra
    touch $out
  '';

  nixpkgs-pin =
    let
      devenvRev = devenvLock.nodes.nixpkgs.locked.rev;
    in
    assert lib.assertMsg (devenvRev == nixpkgsRev)
      "flake.lock pins nixpkgs ${nixpkgsRev}, devenv.lock ${devenvRev}: update them together";
    pkgs.runCommand "slop-node-check-nixpkgs-pin" { } "touch $out";
}
