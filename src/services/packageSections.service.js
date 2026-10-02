// Decoupe la liste des salons du Data Package en sections navigables.
//
// La version precedente wasait une seule colonne triee par volume : 667 lignes
// melangeant MP, groupes et salons de serveur, sans moyen de retrouver un
// serveur. Ici on regroupe : Messages directs, Groupes, puis un bloc par
// serveur, le tout classe par volume decroissant pour que le plus actif reste
// en haut.

const ORPHAN = 'orphan';

export function groupChannels(channels) {
  const list = Array.isArray(channels) ? channels.filter(Boolean) : [];
  if (!list.length) return [];

  const byVolume = (a, b) => (b.messagesCount || 0) - (a.messagesCount || 0);
  const sections = [];
  const guilds = new Map();

  const push = (id, label, kind, items) => {
    items.sort(byVolume);
    sections.push({ id, label, kind, count: items.length, totalMessages: items.reduce((sum, item) => sum + (item.messagesCount || 0), 0), channels: items });
  };

  const dms = [];
  const groups = [];

  for (const channel of list) {
    if (channel.type === 'DM') { dms.push(channel); continue; }
    if (channel.type === 'GROUP') { groups.push(channel); continue; }
    const guildId = channel.guildId ? String(channel.guildId) : ORPHAN;
    if (!guilds.has(guildId)) {
      guilds.set(guildId, { id: guildId, label: channel.guildName || 'Serveurs quittes', items: [] });
    }
    guilds.get(guildId).items.push(channel);
  }

  if (dms.length) push('dm', 'Messages directs', 'dm', dms);
  if (groups.length) push('group', 'Groupes', 'group', groups);

  const guildSections = [...guilds.values()].map(entry => ({
    id: entry.id === ORPHAN ? 'guild-orphan' : `guild-${entry.id}`,
    label: entry.label,
    kind: entry.id === ORPHAN ? 'orphan' : 'guild',
    count: entry.items.length,
    totalMessages: entry.items.reduce((sum, item) => sum + (item.messagesCount || 0), 0),
    channels: entry.items.sort(byVolume),
  }));
  guildSections.sort((a, b) => b.totalMessages - a.totalMessages);
  sections.push(...guildSections);

  return sections;
}