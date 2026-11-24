/**
 * The row picker's trigger: a value lighter than its row's label and a soft right
 * chevron, with no frame or hover fill — Agent Home's side-panel look, and the
 * default for any picker on the right of a settings row. `-mr-1` lets the chevron
 * sit on the row's padding edge, so values line up at their chevrons whatever they
 * read. Stacked form fields and toolbar filters keep the outlined trigger, whose
 * frame is the affordance there.
 */
export const ROW_TRIGGER_CLASS = '-mr-1 h-8 gap-1 px-1 text-[12px]/5 font-normal text-muted-foreground/70 hover:bg-transparent hover:text-muted-foreground/70'

export const ROW_TRIGGER_CHEVRON_CLASS = 'h-4 w-4 shrink-0 text-muted-foreground/50'
