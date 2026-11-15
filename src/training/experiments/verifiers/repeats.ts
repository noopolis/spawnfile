/** The checkpoint key of one further trial of a validation callback; the first trial keeps the callback's own key. */
export const validationRepeatKey = (callback: string, repeat: number): string => `validation-repeat:${JSON.stringify([callback, repeat])}`;

/**
 * Trial noise dwarfs judge noise, so a validation case is run again, never judged again. Repeats run in turn
 * within the callback's own slot, and the search receives their mean.
 */
export async function meanOverRepeats(repeats: number, score: (repeat: number) => Promise<number>): Promise<number> {
  let sum = 0;
  for (let repeat = 0; repeat < repeats; repeat++) sum += await score(repeat);
  return sum / repeats;
}
