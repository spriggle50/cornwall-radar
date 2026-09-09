// A fixed list of Cornwall's designated bathing waters (name + eubwid),
// same pattern as cornwallStations.js and cornwallTowns.js. This exists
// because of a real, repeated production problem: the Environment
// Agency's own Linked Data API (environment.data.gov.uk/doc or /id/
// bathing-water.json) sits behind an Azure Application Gateway that
// returns a bare 403 Forbidden to this app's server-to-server requests —
// confirmed on multiple different URL paths, so it isn't a wrong-endpoint
// bug, and confirmed NOT to affect this project's other Environment
// Agency calls (flood-monitoring works fine from the same server), so
// it's specific to this one sub-service, most likely bot/automated-
// traffic detection at the gateway rather than anything fixable by
// changing the request.
//
// The actual fix: the Environment Agency itself provides an official,
// embeddable widget for exactly this data (environment.data.gov.uk/bwq/
// widget/design), meant to be dropped into third-party sites — and
// because it renders inside the VISITOR'S browser rather than being
// fetched by this app's server, it never hits the same block (confirmed
// working, with live current-season data, while testing this).
//
// This list itself — every Cornwall site's exact name and eubwid — came
// from that same widget designer page: it embeds the complete list of
// all ~464 English bathing waters directly in its own page HTML (a plain
// `var bwNames = [...]` array, server-rendered, no separate API call),
// filtered here down to the ones whose eubwid starts with the Cornwall
// area code prefix "ukk3" (confirmed against known Cornwall sites like
// Kingsand "ukk3101-26520" and Fistral South "ukk3106-32150", both of
// which appear in the API's own official documentation examples).
// Because it's a fixed list rather than a live fetch, a newly-designated
// or de-designated bathing water won't show up here until this list is
// refreshed by hand — acceptable for a list that changes at most once a
// year, and a much better trade than the section being broken entirely.
const BATHING_WATERS = [
  { name: "Booby's Bay", eubwid: 'ukk3104-32750' },
  { name: 'Carbis Bay', eubwid: 'ukk3105-31100' },
  { name: 'Cawsand', eubwid: 'ukk3101-26530' },
  { name: 'Chapel Porth', eubwid: 'ukk3102-31650' },
  { name: 'Charlestown', eubwid: 'ukk3106-27600' },
  { name: 'Church Cove', eubwid: 'ukk3103-29501' },
  { name: 'Constantine Bay', eubwid: 'ukk3104-32700' },
  { name: 'Coverack', eubwid: 'ukk3103-29100' },
  { name: 'Crackington Haven', eubwid: 'ukk3104-33360' },
  { name: 'Crantock', eubwid: 'ukk3106-32100' },
  { name: 'Crinnis Beach', eubwid: 'ukk3106-27500' },
  { name: 'Crooklets', eubwid: 'ukk3104-33600' },
  { name: 'Daymer Bay', eubwid: 'ukk3104-33200' },
  { name: 'Downderry', eubwid: 'ukk3101-26700' },
  { name: 'Duporth', eubwid: 'ukk3106-27700' },
  { name: 'East Looe', eubwid: 'ukk3101-27000' },
  { name: 'Fistral North', eubwid: 'ukk3106-32200' },
  { name: 'Fistral South', eubwid: 'ukk3106-32150' },
  { name: 'Godrevy Towans', eubwid: 'ukk3105-31450' },
  { name: 'Gorran Haven Little Perhaver', eubwid: 'ukk3106-28200' },
  { name: 'Great Western', eubwid: 'ukk3106-32310' },
  { name: 'Gwithian Towans', eubwid: 'ukk3105-31400' },
  { name: 'Gwynver', eubwid: 'ukk3105-30750' },
  { name: 'Gyllyngvase', eubwid: 'ukk3102-28600' },
  { name: 'Harlyn Bay', eubwid: 'ukk3104-32900' },
  { name: 'Hayle Towans', eubwid: 'ukk3105-31300' },
  { name: 'Holywell Bay', eubwid: 'ukk3102-32000' },
  { name: 'Kennack Sands', eubwid: 'ukk3103-29200' },
  { name: 'Kingsand', eubwid: 'ukk3101-26520' },
  { name: 'Long Rock', eubwid: 'ukk3105-30300' },
  { name: 'Lostwithiel, River Fowey', eubwid: 'ukk3008-27080' },
  { name: 'Lusty Glaze', eubwid: 'ukk3106-32330' },
  { name: 'Maenporth', eubwid: 'ukk3102-28800' },
  { name: 'Marazion', eubwid: 'ukk3105-30200' },
  { name: 'Mawgan Porth', eubwid: 'ukk3106-32500' },
  { name: 'Mexico Towans', eubwid: 'ukk3105-31250' },
  { name: 'Millendreath', eubwid: 'ukk3101-26900' },
  { name: "Mother Ivey's Bay", eubwid: 'ukk3104-32800' },
  { name: 'Northcott Mouth', eubwid: 'ukk3104-33650' },
  { name: 'Par Sands', eubwid: 'ukk3106-27300' },
  { name: 'Pendower', eubwid: 'ukk3102-28500' },
  { name: 'Pentewan', eubwid: 'ukk3106-27900' },
  { name: 'Penzance', eubwid: 'ukk3105-30400' },
  { name: 'Perranporth', eubwid: 'ukk3102-31800' },
  { name: 'Perranporth Penhale Sands', eubwid: 'ukk3102-31900' },
  { name: 'Perranuthnoe', eubwid: 'ukk3105-30100' },
  { name: 'Poldhu Cove', eubwid: 'ukk3103-29500' },
  { name: 'Polkerris', eubwid: 'ukk3106-27200' },
  { name: 'Polstreath', eubwid: 'ukk3106-28000' },
  { name: 'Polurrian Cove', eubwid: 'ukk3103-29400' },
  { name: 'Polzeath', eubwid: 'ukk3104-33300' },
  { name: 'Porth', eubwid: 'ukk3106-32340' },
  { name: 'Porthallow', eubwid: 'ukk3103-28900' },
  { name: 'Porthcothan', eubwid: 'ukk3104-32550' },
  { name: 'Porthcurnick', eubwid: 'ukk3102-28550' },
  { name: 'Porthcurno', eubwid: 'ukk3105-30600' },
  { name: 'Porthgwidden', eubwid: 'ukk3105-30900' },
  { name: 'Porthkidney Sands', eubwid: 'ukk3105-31200' },
  { name: 'Porthleven Sands', eubwid: 'ukk3103-29800' },
  { name: 'Porthluney', eubwid: 'ukk3106-28400' },
  { name: 'Porthmeor', eubwid: 'ukk3105-30800' },
  { name: 'Porthminster', eubwid: 'ukk3105-31000' },
  { name: 'Porthoustock', eubwid: 'ukk3103-29000' },
  { name: 'Porthpean', eubwid: 'ukk3106-27800' },
  { name: 'Porthtowan', eubwid: 'ukk3102-31600' },
  { name: 'Portmellon', eubwid: 'ukk3106-28100' },
  { name: 'Portreath', eubwid: 'ukk3103-31500' },
  { name: 'Portwrinkle', eubwid: 'ukk3101-26600' },
  { name: 'Praa Sands East', eubwid: 'ukk3103-29900' },
  { name: 'Praa Sands West', eubwid: 'ukk3103-30000' },
  { name: 'Readymoney Cove', eubwid: 'ukk3106-27100' },
  { name: 'Sandymouth', eubwid: 'ukk3104-33700' },
  { name: 'Seaton (Cornwall)', eubwid: 'ukk3101-26800' },
  { name: 'Sennen', eubwid: 'ukk3105-30700' },
  { name: 'Sharrow', eubwid: 'ukk3101-26570' },
  { name: 'Shorthorn Beach', eubwid: 'ukk3106-27400' },
  { name: 'Summerleaze', eubwid: 'ukk3104-33500' },
  { name: 'Swanpool', eubwid: 'ukk3102-28700' },
  { name: 'Tolcarne', eubwid: 'ukk3106-32320' },
  { name: 'Towan', eubwid: 'ukk3106-32300' },
  { name: 'Trebarwith Strand', eubwid: 'ukk3104-33350' },
  { name: 'Tregonhawke', eubwid: 'ukk3101-26560' },
  { name: 'Trevaunance Cove', eubwid: 'ukk3102-31700' },
  { name: 'Trevone Bay', eubwid: 'ukk3104-33000' },
  { name: 'Treyarnon Bay', eubwid: 'ukk3104-32600' },
  { name: 'Upton Towans', eubwid: 'ukk3105-31350' },
  { name: 'Vault Beach', eubwid: 'ukk3106-28300' },
  { name: 'Watergate Bay', eubwid: 'ukk3106-32400' },
  { name: 'Wherry Town', eubwid: 'ukk3105-30500' },
  { name: 'Widemouth Sand', eubwid: 'ukk3104-33400' },
];

module.exports = { BATHING_WATERS };
