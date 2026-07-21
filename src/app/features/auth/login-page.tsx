import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { AuthShell } from "./auth-shell";

import { loginSchema, type LoginInput } from "@/shared/forms";
import { authClient } from "@/app/api/auth-client";
import { sessionQueryOptions } from "@/app/api/session";
import { useI18n } from "@/app/i18n";
import { Button } from "@/app/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/app/components/ui/form";
import { Input } from "@/app/components/ui/input";


export function LoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = async (values: LoginInput): Promise<void> => {
    const { error } = await authClient.signIn.email({ email: values.email, password: values.password });
    if (error) {
      // The sign-in throttle (worker/middleware/auth-rate-limit.ts) answers 429 in the API's
      // `{ error: { code, message } }` envelope, which Better Auth's client does not flatten
      // onto `error.message` — so branch on the status, or a throttled admin would be told
      // their password was wrong and keep retrying.
      const message =
        error.status === 429
          ? t("auth.login.tooManyAttempts")
          : (error.message ?? t("auth.login.invalidCredentials"));
      form.setError("password", { message });
      return;
    }
    // Clear (not just invalidate) so the route guard's ensureQueryData refetches the
    // fresh session instead of returning the stale cached null.
    queryClient.removeQueries({ queryKey: sessionQueryOptions.queryKey });
    navigate({ to: "/collections" });
  };

  return (
    <AuthShell title={t("auth.login.title")} description={t("auth.login.description")}>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("auth.login.email")}</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="username" placeholder="you@example.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("auth.login.password")}</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? t("auth.login.submitting") : t("auth.login.submit")}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
