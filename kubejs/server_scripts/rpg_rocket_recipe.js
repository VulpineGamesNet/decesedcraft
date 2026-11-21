// RPG-7 rockets (tacz:rpg_rocket) at the Ammo Workbench.
//
// The RPG-7 itself is craftable, but the pack ships no recipe for its rocket (the TaCZ default
// one was dropped from the pack's copy of the gun pack), and the only other source, the loot
// bonus of the Elite Special Force Badge, is out of reach: that badge is in no loot table.
//
// Same recipe type and shape as the pack's own ammo recipes in
// tacz/tacz_default_gun/data/tacz/recipes/ammo/, with a single and a full-stack batch
// (a rocket stacks to 6). The ids are the ones the TaCZ default pack uses.
// To rebalance: edit the per-rocket amounts below, then /reload (with nobody online).

ServerEvents.recipes(event => {
	let rocket = (count, id) => {
		event.custom({
			type: 'tacz:gun_smith_table_crafting',
			materials: [
				{ item: { item: 'minecraft:tnt' }, count: 2 * count },
				{ item: { tag: 'forge:gunpowder' }, count: 4 * count },
				{ item: { tag: 'forge:plates/steel' }, count: 2 * count },
				{ item: { tag: 'forge:plates/aluminum' }, count: 1 * count }
			],
			result: {
				type: 'ammo',
				id: 'tacz:rpg_rocket',
				count: count
			}
		}).id(id)
	}

	rocket(1, 'tacz:ammo/rpg_rocket')
	rocket(6, 'tacz:ammo/rpg_rocket_6')
})
