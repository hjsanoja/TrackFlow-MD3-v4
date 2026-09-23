// supabase/functions/crear-usuario/index.ts
// Supabase Edge Function para creación segura de usuarios por parte de Administradores
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Manejo de preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No se proporcionó el encabezado de autorización." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: "Faltan variables de entorno del servidor (SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY)." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Validar identidad del llamante mediante su token JWT
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user: callerUser }, error: userError } = await userClient.auth.getUser();
    if (userError || !callerUser?.email) {
      return new Response(JSON.stringify({ error: "Sesión del administrador inválida o expirada." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Verificar que el llamante sea realmente administrador según la tabla usuarios
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: callerProfile, error: profileError } = await adminClient
      .from("usuarios")
      .select("rol, activo")
      .eq("email", callerUser.email.toLowerCase())
      .maybeSingle();

    if (profileError || !callerProfile) {
      return new Response(JSON.stringify({ error: "No se encontró el registro del usuario en la base de datos." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isCallerActive = callerProfile.activo === true || callerProfile.activo === "si" || callerProfile.activo === "sí";
    if (callerProfile.rol !== "administrador" || !isCallerActive) {
      return new Response(JSON.stringify({ error: "Acceso denegado: solo usuarios con rol 'administrador' activo pueden registrar nuevos usuarios." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Procesar datos del nuevo usuario a registrar
    const body = await req.json();
    const {
      email,
      password,
      nombre,
      rol,
      menus_permitidos,
      recibe_alertas_inmediatas,
      recibe_resumen_diario,
      activo,
    } = body;

    const emailNormalizado = (email || "").trim().toLowerCase();
    if (!emailNormalizado || !/\S+@\S+\.\S+/.test(emailNormalizado)) {
      return new Response(JSON.stringify({ error: "El correo electrónico proporcionado no es válido." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!password || password.length < 6) {
      return new Response(JSON.stringify({ error: "La contraseña debe tener un mínimo de 6 caracteres." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Crear la cuenta en Supabase Auth mediante API de administración con service_role
    const { data: createdAuthUser, error: authCreateError } = await adminClient.auth.admin.createUser({
      email: emailNormalizado,
      password: password,
      email_confirm: true,
      user_metadata: { nombre: (nombre || "").trim() },
    });

    if (authCreateError) {
      return new Response(JSON.stringify({ error: authCreateError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Registrar el perfil en la tabla 'usuarios'
    const docId = emailNormalizado.replace("@", "_at_").replaceAll(".", "_");
    const rolFinal = rol === "administrador" ? "administrador" : "consulta";
    const menusFinales = Array.isArray(menus_permitidos) && menus_permitidos.length > 0
      ? menus_permitidos
      : (rolFinal === "administrador" ? ["/", "/mapa-calor", "/experimental", "/productos", "/competencia", "/cadenas", "/usuarios"] : ["/", "/mapa-calor"]);

    const { error: dbInsertError } = await adminClient
      .from("usuarios")
      .upsert({
        id: docId,
        email: emailNormalizado,
        nombre: (nombre || "").trim(),
        rol: rolFinal,
        menus_permitidos: menusFinales,
        recibe_alertas_inmediatas: Boolean(recibe_alertas_inmediatas),
        recibe_resumen_diario: Boolean(recibe_resumen_diario),
        activo: activo !== false,
      });

    if (dbInsertError) {
      // Rollback: Si falla la inserción en la tabla usuarios, eliminar la cuenta de Auth para evitar inconsistencias
      await adminClient.auth.admin.deleteUser(createdAuthUser.user.id);
      return new Response(JSON.stringify({ error: `Error guardando en la tabla usuarios: ${dbInsertError.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Usuario ${emailNormalizado} creado exitosamente con rol ${rolFinal}.`,
        user: { id: createdAuthUser.user.id, email: emailNormalizado },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Error inesperado en el servidor." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
