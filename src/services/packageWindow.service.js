// Fenetrage de la liste des salons du Data Package.
//
// 667 salons x ~56 px = environ 37 000 px de haut, alors que la zone visible
// n'en montre qu'une quinzaine. Rendre tout produit 667 noeuds DOM et 667
// images : c'est ce qui rendait le menu de gauche saccade. Ici on ne calcule
// que la tranche a rendre, et deux tampons de hauteur reconstituent la barre de
// defilement pour que la position reste fidele.

export const CHANNEL_ROW_HEIGHT = 56;
export const CHANNEL_OVERSCAN = 20;

export function channelWindow({ total, scrollTop, viewport, rowHeight = CHANNEL_ROW_HEIGHT, overscan = CHANNEL_OVERSCAN } = {}) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const height = Math.max(1, Number(rowHeight) || CHANNEL_ROW_HEIGHT);
  const visibleHeight = Math.max(0, Number(viewport) || 0);
  const offset = Math.max(0, Number(scrollTop) || 0);
  const margin = Math.max(0, Math.floor(Number(overscan) || 0));

  if (!count) return { start: 0, end: 0, padTop: 0, padBottom: 0, offsetTop: 0 };

  // Un scrollTop aberrant (plus grand que la liste) ne doit pas produire une
  // tranche hors bornes : on borne sur la derniere ligne existante.
  const maxFirst = Math.max(0, count - 1);
  const firstVisible = Math.min(maxFirst, Math.floor(offset / height));
  const visibleRows = Math.ceil(visibleHeight / height) + 1;
  const start = Math.max(0, firstVisible - margin);
  const end = Math.min(count, firstVisible + visibleRows + margin);

  return {
    start,
    end,
    padTop: start * height,
    padBottom: Math.max(0, (count - end) * height),
  };
}