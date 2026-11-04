// What the AI is told when tidying the tag list.

export const TIDY_SCHEMA = {
  type: "object",
  properties: {
    merges: {
      type: "array",
      items: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["merges"],
  additionalProperties: false,
};

export const TIDY_SYSTEM = `You clean up the tag list of a bookmark collection. You get every tag with how many bookmarks use it.
Return merges for tags that mean the same thing: plurals and spelling variants ("drawing"/"drawings"), synonyms
("funny"/"humor"), and redundant forms ("illustration-art" -> "illustration"). Merge into the clearest, most-used
name that's already in the list. Don't merge tags that are related but different ("character-design" and
"character-art" are different; "elden-ring" and "nightreign" are different games; a character is not their
franchise). Leave rare tags alone unless they're true duplicates of another tag. Only use tags from the list.`;
