import { selectRandomMood } from "./moods.ts";

const mood = selectRandomMood();
console.log(JSON.stringify(mood));
