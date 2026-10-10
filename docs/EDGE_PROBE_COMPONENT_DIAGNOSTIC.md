# Component first-gate diagnostic (2026-10-06)

The user's one installed 0.1.1 MAIN probe reported `componentMatched=false`; later iframe/identity/body/image checks were not reached. A visible normal article and this result establish neither absent Vue state nor the exact component currently attached to the DOM root.

The exact old probe branch requires the official origin, `/web/mp/reader/...` path and one `.wr_mp_reader` first, then evaluates `root.__vue__?.$options?.name !== 'MpReader'`. It returned the same false for a missing expando, null/missing instance, missing options/name, and a genuinely different name. The projection independently has the same strict name gate and would stop before article business fields. The screenshot and old result cannot distinguish these cases.

Offline evidence only: the already-saved public `19.42e251bc.js` declares `{'name':'MpReader',...}` (name token at zero-based text offset 373686) and renders `div` with `staticClass:'wr_mp_reader'` (459172). The saved public `app.88f998b2.js` Vue update code assigns the instance to `$el.__vue__` (1948511). These are saved-client facts, not proof that the current live page has identical code, mounting or root instance. No bundle was executed and no new platform request was made.

Public asset fingerprints: reader SHA256 `85bea05005a543894c346a39cae5a234b9d77de322316b3a80e87de809af3a3e`; app SHA256 `996a561d9fb7f79bf4289a91e2b6f77dc617eb2bb9352c0320b33c87b9f3bf51`. Neither raw assets nor private page evidence are included in this change.

0.1.2 is a diagnostic candidate, not a claimed locator fix. On that same exact root it reports only:

- `vuePropertyPresent`, `vueValuePresent`, `optionsPresent`, `namePresent` booleans.
- If an instance exists: whether the three audited display properties `bookInfo`, `currentChapter`, `mpRawData` are defined, using `in`, without reading their values or invoking those getters.
- `componentMatched=false` only when a nonempty name is present and differs from MpReader. Missing name keeps component matching unverified. No arbitrary component name is returned.

There is no parent/child traversal, alternate selector, store/global dump, authentication read, method dispatch, network request, permission addition or automatic retry. The strict MpReader gate and projection remain unchanged. Business data is still not collected on an unsuccessful gate. Existing body/media checks retain their prior meaning and do not prove upstream completeness.

The next minimal live evidence contract is one user-authorized manual read-only execution of this reviewed diagnostic on the same visible official article: return only the above summary booleans. It can distinguish inaccessible/null root state, nameless options, a real name mismatch, and whether the same root defines the expected business display fields. A differing name or defined fields does not itself authorize relaxing the locator. The parent/owner must review that result before any further change. Do not automatically run this diagnostic or bypass an internal-page tool refusal.

Local validation: all 24 extension offline tests passed, including missing property/null instance/missing options/name/other-name cases and getters that throw if business values, secrets or component trees are read. Tests are synthetic and do not establish live success. No installation or second live probe occurred in this work.
