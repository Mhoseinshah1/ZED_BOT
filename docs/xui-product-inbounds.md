# XUI Product-Level Inbound Selection

Which inbounds a sold Service is attached to, and why a paid Order's
entitlement can never change after payment. (Extracted from
`docs/xui-provisioning.md`, which keeps the provisioning-side details.)

## Configuration hierarchy

- **Panel level** (`Panel.inboundIds`): the ALLOWLIST of inbound ids
  ZED_BOT may use on this panel. The authenticated readiness check
  validates every allowlisted id against the live panel (exists, enabled,
  supported protocol).
- **Product level** (`Product.inboundIds`): each SERVICE_PRODUCT selects
  its own SUBSET of the panel allowlist. `null`/empty inherits the full
  allowlist (backward compatible). Admins edit the selection under
  Product/Plan Management -> product detail -> «انتخاب اینباند XUI».

Validation is `resolveProductInboundIds` (local, pure): a selected id
outside the allowlist makes the product **unsellable** - hidden from the
catalog, blocked at checkout and at the pre-charge wallet re-check, and a
paid order that somehow reaches provisioning fails definitively BEFORE any
panel call and refunds. Shrinking the panel allowlist warns about products
whose selection now violates it.

```text
Panel allowed inbound IDs:   [3, 5, 8, 12]
Product A selection:         [3, 5]      -> client attached to 3, 5
Product B selection:         null        -> client attached to 3, 5, 8, 12
Product C selection:         [5, 99]     -> invalid: 99 outside the allowlist
```

## The sold set is snapshotted at checkout

- `buildProductSnapshot` resolves the product's effective selection when
  the checkout snapshot is built (inherited selections are MATERIALIZED);
- both payment paths (wallet and receipt approval) persist it as
  `Order.inboundIdsSnapshot`;
- provisioning attaches the global client to the snapshot when present -
  **product or panel edits after payment never change a paid order's
  entitlement**, and retries provision the identical set;
- legacy orders without a snapshot resolve from live config as before.

## Lifecycle operations never re-attach inbounds

The global-client lifecycle operations
(`docs/xui-global-client-lifecycle.md`) mutate the CENTRAL client row
(quota, expiry, enable flag, subId) with one `update/{email}` call; the
panel itself propagates to every attached inbound. Renewal, extra volume,
extra time, toggling and subscription regeneration therefore never change
which inbounds a service is attached to - the attachment set remains the
one provisioned from the order's snapshot.
