// Shared business constants. Kept here rather than inlined wherever
// they're used so the admin overview page and the per-cycle sales
// report can't silently drift out of sync with each other.

// Geonode wholesale cost per GB, in USD. Used to estimate COGS on both
// /admin (all-time) and /admin/cycles (per biweekly cycle).
export const GEONODE_COST_PER_GB_USD = 0.49
