# Every build artifact is defined here; "package.json" only exposes the
# binaries of the npm packages. Run "make help" for a list of targets.

CLEAN_GOALS := $(filter clean distclean,$(MAKECMDGOALS))
OTHER_GOALS := $(filter-out clean distclean,$(MAKECMDGOALS))

ifneq ($(and $(CLEAN_GOALS),$(OTHER_GOALS)),)

# Under -j make stats the targets before "clean" has deleted them, so it
# would judge them up to date. Running the clean goals to completion in a
# separate make first gives the rest a fresh view of the tree.
.PHONY: run-mixed-goals $(MAKECMDGOALS)
$(MAKECMDGOALS): run-mixed-goals
	@:

run-mixed-goals:
	$(MAKE) $(CLEAN_GOALS)
	$(MAKE) $(OTHER_GOALS)

else

KEETANET_CLIENT_VERSION := $(shell jq -r '.dependencies["@keetanetwork/keetanet-client"]' package.json)

# A missing jq or a missing field would otherwise name the tree reference/null.
ifeq ($(filter-out null,$(KEETANET_CLIENT_VERSION)),)
$(error cannot read the keetanet-client version from package.json)
endif

# A version names a directory that the reference rule deletes, so it is
# accepted only when it is made of version characters and starts with a letter
# or digit. Deleting every permitted character leaves just the offending ones.
version-characters := 0 1 2 3 4 5 6 7 8 9 a b c d e f g h i j k l m n o p q r s t u v w x y z A B C D E F G H I J K L M N O P Q R S T U V W X Y Z . + -
remove-version-characters = $(if $(2),$(call remove-version-characters,$(subst $(firstword $(2)),,$(1)),$(wordlist 2,$(words $(2)),$(2))),$(1))
is-invalid-version = $(or $(if $(1),,empty),$(filter .% +% -%,$(1)),$(word 2,$(1)),$(strip $(call remove-version-characters,$(1),$(version-characters))))

ifneq ($(filter reference-diff,$(MAKECMDGOALS)),)
$(foreach side,FROM TO,$(if $($(side)),$(if $(call is-invalid-version,$($(side))),$(error $(side) is not an exact version: $($(side))))))
endif

all: dist .nvmrc

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all            - Builds the project"
	@echo "  dist           - Builds the distribution directory"
	@echo "  test           - Type-checks and runs the test suite"
	@echo "                   Specify extra flags with SLOP_NODE_TEST_EXTRA_ARGS"
	@echo "  do-lint        - Runs the ASCII check, eslint and cspell"
	@echo "  conformance    - Regenerates the vote-decision corpus in conformance/"
	@echo "  reference      - Extracts the reference tree for the pinned keetanet-client"
	@echo "  reference-diff - Diffs the reference trees of two versions"
	@echo "                   Specify FROM=<version> TO=<version>"
	@echo "  clean          - Removes build artifacts"
	@echo "  distclean      - Removes all build artifacts and dependencies"

.nvmrc: package.json Makefile
	rm -f .nvmrc .nvmrc.new
	jq -rM '"v" + .engines.node' < package.json > .nvmrc.new
	mv .nvmrc.new .nvmrc

INSTALL_NODE_MODULES = rm -rf node_modules && npm clean-install --ignore-scripts && touch node_modules/.done

node_modules/.done: package.json package-lock.json
	$(INSTALL_NODE_MODULES)

# Patches are written against one exact release, and patch refuses to apply
# twice, so a stale stamp or a half-patched tree starts again from a clean
# install. Everything that runs or type-checks code depends on this stamp. The
# reinstall runs inline: a recipe line naming $(MAKE) runs even under make -n,
# and would delete the stamps of a dry run.
node_modules/.patched: node_modules/.done $(wildcard patches/keetanet-client@*/*.patch) utils/apply-patches
	if [ -e node_modules/.patched ]; then \
		$(INSTALL_NODE_MODULES); \
	fi
	utils/apply-patches node_modules/@keetanetwork/keetanet-client patches || { rm -f node_modules/.done; exit 1; }
	@touch node_modules/.patched

# The directory itself is the target here, so it only follows the stamp.
node_modules: node_modules/.patched
	@touch node_modules

# Compiled tests stay out of the distribution. The build info lives in dist, so
# removing dist removes it too; without the stamp the directory may be partial,
# which an incremental build would not notice, so it starts from scratch.
dist/.done: $(shell find src -type f -name '*.ts' -not -name '*.test.ts') tsconfig.json tsconfig.build.json node_modules/.patched
	@[ -e dist/.done ] || rm -f dist/.tsbuildinfo
	npm run tsc -- -p tsconfig.build.json
	@touch dist/.done

dist: dist/.done
	@touch dist

build/utils/.done: $(shell find utils -type f -name '*.ts' -not -path 'utils/lint-fixtures/*') utils/tsconfig.json tsconfig.json node_modules/.patched
	@[ -e build/utils/.done ] || rm -f build/utils/.tsbuildinfo
	npm run tsc -- -p utils
	@touch build/utils/.done

# The type checks cover the tests that the builds exclude, so they must not
# write the build info that the builds read.
test: dist/.done build/utils/.done
	npm run tsc -- --noEmit --incremental false
	npm run tsc -- --noEmit --incremental false -p utils
	npm run vitest -- run --config .vitest.config.js $(SLOP_NODE_TEST_EXTRA_ARGS)

# The corpus records what upstream's ledger decides, so it is regenerated from
# the scenarios rather than edited; "make test" then checks it is current.
conformance: node_modules/.patched
	SLOP_NODE_UPDATE_CONFORMANCE=1 npm run vitest -- run --config .vitest.config.js src/conformance/corpus.test.ts

# git grep exits 1 when nothing matches and 128 when it fails, and only the
# first means the tree is clean.
do-lint: node_modules/.patched
	@LC_ALL=C git grep -I -n --untracked '[^[:print:][:space:]]' -- . ':!LICENSE'; \
	status=$$?; \
	if [ $$status -eq 0 ]; then \
		echo "Error: Found non-ASCII characters in the source code." >&2; \
		exit 1; \
	fi; \
	if [ $$status -ne 1 ]; then \
		echo "Error: git grep failed with status $$status." >&2; \
		exit $$status; \
	fi
	npm run eslint -- --config .eslint.config.mjs src utils
	npm run cspell -- --config .cspell.config.mjs --no-progress 'src/**/*.ts' 'utils/**/*.ts' 'schema/*.md' Makefile

# The tree is built beside its final name and renamed, so an interrupted run
# never leaves a partial directory that looks complete. Every version, the
# pinned one included, comes from its integrity-checked tarball rather than from
# node_modules, so the patches never reach the reference. Each version has its
# own download directory so that parallel runs do not collide. The stem goes
# through the environment rather than into the shell text, and is validated
# before anything is deleted.
reference/%/.done: export REFERENCE_VERSION = $*
reference/%/.done: build/utils/.done utils/fetch-keetanet-client
	@case "$$REFERENCE_VERSION" in \
		''|[!0-9A-Za-z]*|*[!0-9A-Za-z.+-]*) \
			echo "Error: not an exact version: $$REFERENCE_VERSION" >&2; \
			exit 2;; \
	esac
	rm -rf "reference/$$REFERENCE_VERSION" "reference/$$REFERENCE_VERSION.tmp"
	@package="reference/.packages/$$REFERENCE_VERSION"; \
	rm -rf "$$package"; \
	utils/fetch-keetanet-client "$$REFERENCE_VERSION" "$$package" || exit 1; \
	node build/utils/reference/main.js --package "$$package" --out "reference/$$REFERENCE_VERSION.tmp"
	mv "reference/$$REFERENCE_VERSION.tmp" "reference/$$REFERENCE_VERSION"
	@touch "reference/$$REFERENCE_VERSION/.done"

reference: reference/$(KEETANET_CLIENT_VERSION)/.done

reference-diff-usage:
	@echo "Usage: make reference-diff FROM=<version> TO=<version>" >&2
	@exit 2

# Review aid for upstream releases, so differences are not a failure.
reference-diff: $(if $(and $(FROM),$(TO)),reference/$(FROM)/.done reference/$(TO)/.done,reference-diff-usage)
	@changed=0; \
	for tree in modules lib api; do \
		diff -ruN reference/$(FROM)/$$tree reference/$(TO)/$$tree || { \
			status=$$?; \
			[ $$status -eq 1 ] || exit $$status; \
			changed=1; \
		}; \
	done; \
	[ $$changed -eq 1 ] || echo "no differences"

clean:
	rm -rf dist build .coverage

distclean: clean
	rm -rf node_modules .nvmrc reference

.PHONY: all help test conformance do-lint reference reference-diff reference-diff-usage clean distclean

endif
