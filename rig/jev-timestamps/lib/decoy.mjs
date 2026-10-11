// SYNTHETIC decoy segments, used only when no --decoy-note is given. Each is
// on a deliberately obscure topic that a typical note will not cover, so a
// real matcher should answer does_not_pertain (or insufficient_evidence) for
// every cell. If a note happens to be ABOUT one of these topics, that cell is
// not a fair decoy; the output says these segments are synthetic.
const TEXTS = [
  "To start a sourdough levain you mix equal weights of rye flour and water, then discard and feed it every twelve hours until it doubles reliably.",
  "Tide pools at low water hold anemones, hermit crabs and limpets that cling to rock with a single muscular foot.",
  "A beekeeper checks each frame for capped brood, queen cells and signs of varroa mites before deciding whether to split the hive.",
  "In medieval bookbinding, quires of folded parchment were sewn onto raised cords and the boards were covered in tawed leather.",
  "Cast-on stitches for a sock begin at the cuff, are divided over four double-pointed needles, and joined in the round without twisting.",
  "The violin's sound post is a small spruce dowel wedged between the top and back plates just behind the treble foot of the bridge.",
  "Competitive ferret shows judge coat condition, temperament and how the animal handles being lifted by the judge.",
  "Lichens are partnerships of a fungus and an alga, and some species grow less than a millimetre a year on bare granite.",
  "A dry-stone waller sets the largest stones as footings, keeps the batter consistent, and fills the core with small hearting stones.",
  "Pétanque players throw hollow steel boules from a circle, trying to land closest to the small wooden jack.",
];

/** The synthetic decoy segments, shaped like parsed transcript segments. */
export function syntheticDecoySegments() {
  return TEXTS.map((text, index) => ({ index, startSeconds: null, text }));
}
