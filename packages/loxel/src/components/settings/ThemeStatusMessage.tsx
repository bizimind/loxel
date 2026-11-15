export interface ThemeStatus {
  error: boolean;
  message: string;
}

/** The outcome of a theme or color scheme import, under its button. */
export function ThemeStatusMessage({ status }: { status: ThemeStatus }) {
  return (
    <p
      role={status.error ? "alert" : "status"}
      className={
        status.error ? "text-destructive text-[10px]" : "text-muted-foreground text-[10px]"
      }
    >
      {status.message}
    </p>
  );
}
