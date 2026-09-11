#!/usr/bin/env bash
# SOQ-TEC terminal deploy script: retired.
#
# The Cloudflare Pages project behind soqtec.soqu.org is deployed from the ops
# repository, not from this repository root. This script refuses to run so that
# a re-run cannot republish the repository root over the live site.

echo "retired: the SOQ-TEC terminal deploy is retired; the site is deployed from the ops repository." >&2
exit 1
