---
namespace: fixture
description: Namespace module for the sibling-steps fixtures
---

<script>
// Proves a STEP can reach a namespace helper. Steps used to be compiled with an
// empty module script, so this was defined for index.md and undefined in the
// step beside it.
const helperFromModule = () => 'HELPER REACHED'
</script>

## Overview

Fixture namespace.
