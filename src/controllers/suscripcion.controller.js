const db = require("../config/db");
const { getMexicoISO } = require("../utils/date.utils");
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

// Inicializar el cliente con tu credencial del .env
const client = new MercadoPagoConfig({ 
  accessToken: process.env.MP_ACCESS_TOKEN || '' 
});


let sendVencimientoEmail, sendNotificacionManualEmail;
try {
  const emailUtils = require("../utils/emailSuscripcion.utils");
  sendVencimientoEmail = emailUtils.sendVencimientoEmail;
  sendNotificacionManualEmail = emailUtils.sendNotificacionManualEmail;
} catch (error) {
  console.warn("Email utils no encontrado, las notificaciones por correo no estarán disponibles");
  sendVencimientoEmail = async () => console.log("Email no enviado - utils no disponible");
  sendNotificacionManualEmail = async () => console.log("Email no enviado - utils no disponible");
}

const getTableNames = (tipo) => {
  if (tipo === 'cliente') {
    return { usuarios: 'usuarios_clientes' };
  }
  return { usuarios: 'usuarios' };
};

exports.getTiposSuscripcion = async (req, res) => {
  try {
    const [tipos] = await db.execute(
      "SELECT * FROM tipos_suscripcion WHERE activo = 1 ORDER BY orden, precio_centavos"
    );
    return res.json({ tipos });
  } catch (error) {
    console.error("Error en getTiposSuscripcion:", error);
    return res.status(500).json({ error: "Error al obtener tipos de suscripción" });
  }
};

exports.getMiSuscripcion = async (req, res) => {
  try {
    const usuarioid = req.user.usuarioid;
    const tipo = req.user.tipo || 'cliente';
    const tablas = getTableNames(tipo);

    const [suscripciones] = await db.execute(
      `SELECT s.*, ts.nombre as plan_nombre, ts.descripcion as plan_descripcion,
              ts.max_tarjetas, ts.max_plantillas_personalizadas, ts.qr_dinamico,
              ts.analitica_avanzada, ts.soporte_prioritario, ts.duracion_dias,
              m.simbolo as moneda_simbolo, m.codigo as moneda_codigo
       FROM suscripciones_usuarios s
       INNER JOIN tipos_suscripcion ts ON s.tiposuscripcionid = ts.tiposuscripcionid
       LEFT JOIN monedas m ON ts.monedaid = m.monedaid
       WHERE s.usuarioid = ? AND s.tipo_usuario = ? AND s.estado = 'activa'
       ORDER BY s.suscripcionid DESC LIMIT 1`,
      [usuarioid, tipo]
    );

    if (suscripciones.length === 0) {
      const [ultima] = await db.execute(
        `SELECT s.*, ts.nombre as plan_nombre, ts.max_tarjetas,
                m.simbolo as moneda_simbolo
         FROM suscripciones_usuarios s
         INNER JOIN tipos_suscripcion ts ON s.tiposuscripcionid = ts.tiposuscripcionid
         LEFT JOIN monedas m ON ts.monedaid = m.monedaid
         WHERE s.usuarioid = ? AND s.tipo_usuario = ?
         ORDER BY s.suscripcionid DESC LIMIT 1`,
        [usuarioid, tipo]
      );
      
      if (ultima.length > 0) {
        return res.json({
          tiene_suscripcion: false,
          ultima_suscripcion: ultima[0],
          mensaje: "No tienes una suscripción activa"
        });
      }
      
      return res.json({
        tiene_suscripcion: false,
        mensaje: "No tienes ninguna suscripción"
      });
    }

    const suscripcion = suscripciones[0];
    const dias_restantes = Math.ceil((new Date(suscripcion.fecha_fin) - new Date()) / (1000 * 60 * 60 * 24));
    
    return res.json({
      tiene_suscripcion: true,
      suscripcion: {
        ...suscripcion,
        dias_restantes: dias_restantes > 0 ? dias_restantes : 0,
        esta_vencida: dias_restantes <= 0
      }
    });
  } catch (error) {
    console.error("Error en getMiSuscripcion:", error);
    return res.status(500).json({ error: "Error al obtener suscripción" });
  }
};

exports.crearSuscripcion = async (req, res) => {
  try {
    const usuarioid = req.user.usuarioid;
    const tipo = req.user.tipo || 'cliente';
    const { tiposuscripcionid, metodo_pago = 'simulado', renovar_automatico = false } = req.body;
    const [existente] = await db.execute(
      "SELECT * FROM suscripciones_usuarios WHERE usuarioid = ? AND estado = 'activa'", 
      [usuarioid]
    );
    
    if (existente.length > 0) {
      return res.status(400).json({ 
        error: "Ya tienes una suscripción activa. No puedes duplicarla." 
      });
    }

    if (!tiposuscripcionid) {
      return res.status(400).json({ error: "Se requiere el tipo de suscripción" });
    }

    const [tipos] = await db.execute(
      "SELECT * FROM tipos_suscripcion WHERE tiposuscripcionid = ? AND activo = 1",
      [tiposuscripcionid]
    );

    if (tipos.length === 0) {
      return res.status(404).json({ error: "Tipo de suscripción no encontrado" });
    }

    const plan = tipos[0];
    const fecha_inicio = getMexicoISO().split('T')[0];
    const fecha_fin = new Date();
    fecha_fin.setDate(fecha_fin.getDate() + plan.duracion_dias);
    const fecha_fin_str = fecha_fin.toISOString().split('T')[0];

    await db.execute(
      `UPDATE suscripciones_usuarios 
       SET estado = 'cancelada', actualizado = NOW()
       WHERE usuarioid = ? AND tipo_usuario = ? AND estado = 'activa'`,
      [usuarioid, tipo]
    );

    const [result] = await db.execute(
      `INSERT INTO suscripciones_usuarios 
       (usuarioid, tipo_usuario, tiposuscripcionid, fecha_inicio, fecha_fin, 
        fecha_ultima_renovacion, estado, automatico_renovar, ultimo_pago_id, notas)
       VALUES (?, ?, ?, ?, ?, NOW(), 'activa', ?, ?, ?)`,
      [usuarioid, tipo, tiposuscripcionid, fecha_inicio, fecha_fin_str, 
       renovar_automatico ? 1 : 0, `pago_${Date.now()}`, `Suscripción ${plan.nombre} - Método: ${metodo_pago}`]
    );

    await db.execute(
      `INSERT INTO historial_suscripciones 
       (suscripcionid, usuarioid, tipo_usuario, tiposuscripcionid, 
        fecha_inicio, fecha_fin, motivo, estado_anterior, estado_nuevo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [result.insertId, usuarioid, tipo, tiposuscripcionid, 
       fecha_inicio, fecha_fin_str, 'Nueva suscripción', 'none', 'activa']
    );

    return res.status(201).json({
      message: "Suscripción creada exitosamente",
      suscripcionid: result.insertId,
      fecha_inicio,
      fecha_fin: fecha_fin_str,
      plan: plan.nombre
    });
  } catch (error) {
    console.error("Error en crearSuscripcion:", error);
    return res.status(500).json({ error: "Error al crear suscripción" });
  }
};

exports.cancelarSuscripcion = async (req, res) => {
  try {
    const usuarioid = req.user.usuarioid;
    const tipo = req.user.tipo || 'cliente';

    const [suscripciones] = await db.execute(
      `SELECT suscripcionid, tiposuscripcionid, fecha_inicio, fecha_fin, estado
       FROM suscripciones_usuarios
       WHERE usuarioid = ? AND tipo_usuario = ? AND estado = 'activa'
       ORDER BY suscripcionid DESC LIMIT 1`,
      [usuarioid, tipo]
    );

    if (suscripciones.length === 0) {
      return res.status(404).json({ error: "No tienes una suscripción activa" });
    }

    const suscripcion = suscripciones[0];
    const estado_anterior = suscripcion.estado;

    await db.execute(
      `UPDATE suscripciones_usuarios 
      SET estado = 'cancelada', automatico_renovar = 0, actualizado = NOW()
      WHERE suscripcionid = ?`,
      [suscripcion.suscripcionid]
    );

    await db.execute(
      `INSERT INTO historial_suscripciones 
       (suscripcionid, usuarioid, tipo_usuario, tiposuscripcionid, 
        fecha_inicio, fecha_fin, motivo, estado_anterior, estado_nuevo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [suscripcion.suscripcionid, usuarioid, tipo, suscripcion.tiposuscripcionid,
       suscripcion.fecha_inicio, suscripcion.fecha_fin, 
       'Cancelación por usuario', estado_anterior, 'cancelada']
    );

    return res.json({
      message: "Suscripción cancelada exitosamente"
    });
  } catch (error) {
    console.error("Error en cancelarSuscripcion:", error);
    return res.status(500).json({ error: "Error al cancelar suscripción" });
  }
};

exports.getHistorialSuscripciones = async (req, res) => {
  try {
    const usuarioid = req.user.usuarioid;
    const tipo = req.user.tipo || 'cliente';
    const { limite = 20, pagina = 1 } = req.query;

    const limiteNum = parseInt(limite);
    const paginaNum = parseInt(pagina);
    const offset = (paginaNum - 1) * limiteNum;

    const [historial] = await db.execute(
      `SELECT h.*, ts.nombre as plan_nombre, ts.precio_centavos, m.simbolo as moneda_simbolo
       FROM historial_suscripciones h
       INNER JOIN tipos_suscripcion ts ON h.tiposuscripcionid = ts.tiposuscripcionid
       LEFT JOIN monedas m ON ts.monedaid = m.monedaid
       WHERE h.usuarioid = ? AND h.tipo_usuario = ?
       ORDER BY h.fecha_cambio DESC
       LIMIT ? OFFSET ?`,
      [usuarioid, tipo, limiteNum, offset]
    );

    const [total] = await db.execute(
      `SELECT COUNT(*) as total FROM historial_suscripciones 
       WHERE usuarioid = ? AND tipo_usuario = ?`,
      [usuarioid, tipo]
    );

    return res.json({
      historial,
      paginacion: {
        pagina: paginaNum,
        limite: limiteNum,
        total: total[0].total,
        paginas: Math.ceil(total[0].total / limiteNum)
      }
    });
  } catch (error) {
    console.error("Error en getHistorialSuscripciones:", error);
    return res.status(500).json({ error: "Error al obtener historial" });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const usuarioid = req.user.usuarioid;
    const tipo = req.user.tipo || 'cliente';

    const [suscripcionActiva] = await db.execute(
      `SELECT s.*, ts.max_tarjetas, ts.max_plantillas_personalizadas, 
              ts.qr_dinamico, ts.analitica_avanzada, ts.soporte_prioritario,
              ts.nombre as plan_nombre
       FROM suscripciones_usuarios s
       INNER JOIN tipos_suscripcion ts ON s.tiposuscripcionid = ts.tiposuscripcionid
       WHERE s.usuarioid = ? AND s.tipo_usuario = ? AND s.estado = 'activa'
       ORDER BY s.suscripcionid DESC LIMIT 1`,
      [usuarioid, tipo]
    );

    let limiteTarjetas = 3;
    let planActual = null;
    let diasRestantes = 0;

    if (suscripcionActiva.length > 0) {
      const sub = suscripcionActiva[0];
      limiteTarjetas = sub.max_tarjetas === 0 ? 999999 : sub.max_tarjetas;
      planActual = {
        id: sub.tiposuscripcionid,
        nombre: sub.plan_nombre,
        max_tarjetas: sub.max_tarjetas,
        qr_dinamico: sub.qr_dinamico === 1,
        analitica_avanzada: sub.analitica_avanzada === 1,
        soporte_prioritario: sub.soporte_prioritario === 1
      };
      diasRestantes = Math.max(0, Math.ceil((new Date(sub.fecha_fin) - new Date()) / (1000 * 60 * 60 * 24)));
    }

    const [tarjetasCount] = await db.execute(
      `SELECT COUNT(*) as total FROM tarjetas_cliente 
       WHERE usuarioid = ? AND activo = 1`,
      [usuarioid]
    );
    const totalTarjetas = tarjetasCount[0].total;

    const [visitasCount] = await db.execute(
      `SELECT COALESCE(SUM(visitas), 0) as total FROM tarjetas_cliente 
       WHERE usuarioid = ? AND visibilidad = 'publico' AND activo = 1`,
      [usuarioid]
    );
    const totalVisitas = visitasCount[0].total;

    const [topTarjetas] = await db.execute(
      `SELECT tarjetaclienteid, nombre_tarjeta, visitas, slug,
              (SELECT nombre FROM plantillas_tarjetas WHERE plantillaid = tc.plantillaid) as plantilla_nombre
       FROM tarjetas_cliente tc
       WHERE usuarioid = ? AND activo = 1 AND visitas > 0
       ORDER BY visitas DESC LIMIT 5`,
      [usuarioid]
    );

    const [actividadReciente] = await db.execute(
      `SELECT tarjetaclienteid, nombre_tarjeta, creado, actualizado,
              (SELECT nombre FROM plantillas_tarjetas WHERE plantillaid = tc.plantillaid) as plantilla_nombre
       FROM tarjetas_cliente tc
       WHERE usuarioid = ? AND activo = 1
       ORDER BY actualizado DESC LIMIT 5`,
      [usuarioid]
    );

    const puedeCrearMas = totalTarjetas < limiteTarjetas || limiteTarjetas === 0;

    const [pub] = await db.execute(
      `SELECT COUNT(*) as total FROM tarjetas_cliente 
       WHERE usuarioid = ? AND visibilidad = 'publico' AND activo = 1`,
      [usuarioid]
    );
    const tarjetasPublicas = pub[0].total;

    const [priv] = await db.execute(
      `SELECT COUNT(*) as total FROM tarjetas_cliente 
       WHERE usuarioid = ? AND visibilidad = 'privado' AND activo = 1`,
      [usuarioid]
    );
    const tarjetasPrivadas = priv[0].total;

    return res.json({
      suscripcion: {
        activa: suscripcionActiva.length > 0,
        plan: planActual,
        dias_restantes: diasRestantes,
        tarjetas_restantes: limiteTarjetas === 0 ? 'Ilimitadas' : Math.max(0, limiteTarjetas - totalTarjetas),
        limite_tarjetas: limiteTarjetas === 0 ? 'Ilimitadas' : limiteTarjetas
      },
      estadisticas: {
        total_tarjetas: totalTarjetas,
        total_visitas: totalVisitas,
        tarjetas_publicas: tarjetasPublicas,
        tarjetas_privadas: tarjetasPrivadas
      },
      top_tarjetas: topTarjetas,
      actividad_reciente: actividadReciente,
      puede_crear_mas_tarjetas: puedeCrearMas,
      mensaje_limite: puedeCrearMas ? null : `Has alcanzado el límite de ${limiteTarjetas} tarjetas de tu plan. Actualiza tu suscripción para crear más.`
    });
  } catch (error) {
    console.error("Error en getDashboardStats:", error);
    return res.status(500).json({ error: "Error al obtener estadísticas del dashboard" });
  }
};

exports.verificarLimitesTarjetas = async (usuarioid, tipo = 'cliente') => {
  try {
    const tipoUsuario = tipo || 'cliente';
    
    const [suscripcion] = await db.execute(
      `SELECT ts.max_tarjetas
       FROM suscripciones_usuarios s
       INNER JOIN tipos_suscripcion ts ON s.tiposuscripcionid = ts.tiposuscripcionid
       WHERE s.usuarioid = ? AND s.tipo_usuario = ? AND s.estado = 'activa'
       ORDER BY s.suscripcionid DESC LIMIT 1`,
      [usuarioid, tipoUsuario]
    );

    let limiteTarjetas = 3;
    if (suscripcion.length > 0) {
      limiteTarjetas = suscripcion[0].max_tarjetas === 0 ? 999999 : suscripcion[0].max_tarjetas;
    }

    const [tarjetasCount] = await db.execute(
      `SELECT COUNT(*) as total FROM tarjetas_cliente 
       WHERE usuarioid = ? AND activo = 1`,
      [usuarioid]
    );

    const totalTarjetas = tarjetasCount[0].total;
    
    return {
      puede_crear: totalTarjetas < limiteTarjetas,
      total_actual: totalTarjetas,
      limite: limiteTarjetas,
      mensaje: totalTarjetas >= limiteTarjetas ? `Has alcanzado el límite de ${limiteTarjetas} tarjetas` : null
    };
  } catch (error) {
    console.error("Error en verificarLimitesTarjetas:", error);
    return { puede_crear: true, total_actual: 0, limite: 999999, mensaje: null };
  }
};

exports.getAllSuscripciones = async (req, res) => {
  try {
    const [suscripciones] = await db.execute(`
      SELECT 
        s.*,
        ts.nombre as plan_nombre,
        uc.nombre as usuario_nombre,
        uc.email as usuario_email
      FROM suscripciones_usuarios s
      LEFT JOIN tipos_suscripcion ts ON s.tiposuscripcionid = ts.tiposuscripcionid
      LEFT JOIN usuarios_clientes uc ON s.usuarioid = uc.usuarioid
      ORDER BY s.suscripcionid DESC
    `);
    
    return res.json({
      success: true,
      total: suscripciones.length,
      suscripciones: suscripciones
    });
    
  } catch (error) {
    console.error("Error en getAllSuscripciones:", error);
    return res.status(500).json({ 
      error: "Error al obtener suscripciones",
      detalle: error.message
    });
  }
};

exports.renovarSuscripcionAdmin = async (req, res) => {
  try {
    const { suscripcionid } = req.params;
    const { dias_extra = null } = req.body;

    const [suscripciones] = await db.execute(
      `SELECT s.*, ts.duracion_dias, ts.nombre as plan_nombre
       FROM suscripciones_usuarios s
       INNER JOIN tipos_suscripcion ts ON s.tiposuscripcionid = ts.tiposuscripcionid
       WHERE s.suscripcionid = ?`,
      [suscripcionid]
    );

    if (suscripciones.length === 0) {
      return res.status(404).json({ error: "Suscripción no encontrada" });
    }

    const suscripcion = suscripciones[0];
    const duracion = dias_extra || suscripcion.duracion_dias;
    
    let nuevaFechaFin = new Date();
    if (suscripcion.estado === 'activa' && new Date(suscripcion.fecha_fin) > new Date()) {
      nuevaFechaFin = new Date(suscripcion.fecha_fin);
    }
    nuevaFechaFin.setDate(nuevaFechaFin.getDate() + duracion);
    const nuevaFechaFinStr = nuevaFechaFin.toISOString().split('T')[0];

    await db.execute(
      `UPDATE suscripciones_usuarios 
       SET fecha_fin = ?, fecha_ultima_renovacion = NOW(), estado = 'activa', actualizado = NOW()
       WHERE suscripcionid = ?`,
      [nuevaFechaFinStr, suscripcionid]
    );

    await db.execute(
      `INSERT INTO historial_suscripciones 
       (suscripcionid, usuarioid, tipo_usuario, tiposuscripcionid, 
        fecha_inicio, fecha_fin, motivo, estado_anterior, estado_nuevo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [suscripcionid, suscripcion.usuarioid, suscripcion.tipo_usuario, suscripcion.tiposuscripcionid,
       suscripcion.fecha_inicio, nuevaFechaFinStr, 
       `Renovación admin - ${duracion} días`, suscripcion.estado, 'activa']
    );

    return res.json({
      message: "Suscripción renovada exitosamente",
      nueva_fecha_fin: nuevaFechaFinStr
    });
  } catch (error) {
    console.error("Error en renovarSuscripcionAdmin:", error);
    return res.status(500).json({ error: "Error al renovar suscripción" });
  }
};

exports.getClientesList = async (req, res) => {
  try {
    const [clientes] = await db.execute(
      "SELECT usuarioid, nombre, email FROM usuarios_clientes WHERE activo = 1 ORDER BY nombre"
    );
    return res.json({ clientes });
  } catch (error) {
    console.error("Error en getClientesList:", error);
    return res.status(500).json({ error: "Error al obtener clientes" });
  }
};

exports.crearSuscripcionAdmin = async (req, res) => {
  try {
    const { usuarioid, tiposuscripcionid, dias, renovar_automatico = false } = req.body;

    if (!usuarioid || !tiposuscripcionid) {
      return res.status(400).json({ error: "Faltan datos requeridos" });
    }

    const [plan] = await db.execute(
      "SELECT * FROM tipos_suscripcion WHERE tiposuscripcionid = ? AND activo = 1",
      [tiposuscripcionid]
    );

    if (plan.length === 0) {
      return res.status(404).json({ error: "Plan no encontrado" });
    }

    const duracionDias = dias || plan[0].duracion_dias;
    const fecha_inicio = getMexicoISO().split('T')[0];
    const fecha_fin = new Date();
    fecha_fin.setDate(fecha_fin.getDate() + duracionDias);
    const fecha_fin_str = fecha_fin.toISOString().split('T')[0];

    await db.execute(
      `UPDATE suscripciones_usuarios 
       SET estado = 'cancelada', actualizado = NOW()
       WHERE usuarioid = ? AND tipo_usuario = 'cliente' AND estado = 'activa'`,
      [usuarioid]
    );

    const [result] = await db.execute(
      `INSERT INTO suscripciones_usuarios 
       (usuarioid, tipo_usuario, tiposuscripcionid, fecha_inicio, fecha_fin, 
        fecha_ultima_renovacion, estado, automatico_renovar, ultimo_pago_id, notas)
       VALUES (?, 'cliente', ?, ?, ?, NOW(), 'activa', ?, ?, ?)`,
      [usuarioid, tiposuscripcionid, fecha_inicio, fecha_fin_str, 
       renovar_automatico ? 1 : 0, `admin_${Date.now()}`, `Suscripción creada por admin - ${plan[0].nombre}`]
    );

    await db.execute(
      `INSERT INTO historial_suscripciones 
       (suscripcionid, usuarioid, tipo_usuario, tiposuscripcionid, 
        fecha_inicio, fecha_fin, motivo, estado_anterior, estado_nuevo)
       VALUES (?, ?, 'cliente', ?, ?, ?, ?, ?, ?)`,
      [result.insertId, usuarioid, tiposuscripcionid, 
       fecha_inicio, fecha_fin_str, 'Creada por admin', 'none', 'activa']
    );

    const [cliente] = await db.execute(
      "SELECT email, nombre FROM usuarios_clientes WHERE usuarioid = ?",
      [usuarioid]
    );

    if (cliente.length > 0) {
      await sendNotificacionManualEmail(cliente[0].email, cliente[0].nombre, plan[0].nombre, fecha_fin_str);
    }

    return res.status(201).json({
      success: true,
      message: "Suscripción creada exitosamente",
      suscripcionid: result.insertId,
      fecha_inicio,
      fecha_fin: fecha_fin_str,
      plan: plan[0].nombre
    });
  } catch (error) {
    console.error("Error en crearSuscripcionAdmin:", error);
    return res.status(500).json({ error: "Error al crear suscripción" });
  }
};

exports.enviarNotificacionVencimiento = async (req, res) => {
  try {
    const { suscripcionid } = req.params;

    const [suscripcion] = await db.execute(
      `SELECT s.*, ts.nombre as plan_nombre, 
              COALESCE(uc.email, u.email) as email,
              COALESCE(uc.nombre, u.nombre) as usuario_nombre
       FROM suscripciones_usuarios s
       INNER JOIN tipos_suscripcion ts ON s.tiposuscripcionid = ts.tiposuscripcionid
       LEFT JOIN usuarios_clientes uc ON s.usuarioid = uc.usuarioid AND s.tipo_usuario = 'cliente'
       LEFT JOIN usuarios u ON s.usuarioid = u.usuarioid AND s.tipo_usuario = 'admin'
       WHERE s.suscripcionid = ?`,
      [suscripcionid]
    );

    if (suscripcion.length === 0) {
      return res.status(404).json({ error: "Suscripción no encontrada" });
    }

    const data = suscripcion[0];
    const diasRestantes = Math.max(0, Math.ceil((new Date(data.fecha_fin) - new Date()) / (1000 * 60 * 60 * 24)));

    await sendVencimientoEmail(data.email, data.usuario_nombre, diasRestantes, data.fecha_fin, data.plan_nombre);

    return res.json({
      success: true,
      message: "Notificación de vencimiento enviada exitosamente"
    });
  } catch (error) {
    console.error("Error en enviarNotificacionVencimiento:", error);
    return res.status(500).json({ error: "Error al enviar notificación" });
  }
};

exports.verificarYNotificarVencimientos = async (req, res) => {
  try {
    const hoy = new Date();
    const dentroDe7Dias = new Date();
    dentroDe7Dias.setDate(dentroDe7Dias.getDate() + 7);

    const [suscripciones] = await db.execute(
      `SELECT s.*, ts.nombre as plan_nombre,
              COALESCE(uc.email, u.email) as email,
              COALESCE(uc.nombre, u.nombre) as usuario_nombre
       FROM suscripciones_usuarios s
       INNER JOIN tipos_suscripcion ts ON s.tiposuscripcionid = ts.tiposuscripcionid
       LEFT JOIN usuarios_clientes uc ON s.usuarioid = uc.usuarioid AND s.tipo_usuario = 'cliente'
       LEFT JOIN usuarios u ON s.usuarioid = u.usuarioid AND s.tipo_usuario = 'admin'
       WHERE s.estado = 'activa' 
         AND s.fecha_fin <= ?
         AND s.fecha_fin >= ?
         AND (s.ultimo_recordatorio IS NULL OR s.ultimo_recordatorio < DATE_SUB(NOW(), INTERVAL 1 DAY))`,
      [dentroDe7Dias.toISOString().split('T')[0], hoy.toISOString().split('T')[0]]
    );

    const resultados = [];
    for (const sub of suscripciones) {
      const diasRestantes = Math.ceil((new Date(sub.fecha_fin) - hoy) / (1000 * 60 * 60 * 24));
      await sendVencimientoEmail(sub.email, sub.usuario_nombre, diasRestantes, sub.fecha_fin, sub.plan_nombre);
      
      await db.execute(
        `UPDATE suscripciones_usuarios SET ultimo_recordatorio = NOW() WHERE suscripcionid = ?`,
        [sub.suscripcionid]
      );
      
      resultados.push({
        email: sub.email,
        usuario: sub.usuario_nombre,
        dias_restantes: diasRestantes,
        enviado: true
      });
    }

    return res.json({
      success: true,
      notificaciones_enviadas: resultados.length,
      detalles: resultados
    });
  } catch (error) {
    console.error("Error en verificarYNotificarVencimientos:", error);
    return res.status(500).json({ error: "Error al verificar vencimientos" });
  }
};

exports.crearPreferenciaPago = async (req, res) => {
  try {
    const planOriginal = req.body.tiposuscripcionid; // Recibe "premium" o "business"
    const periodo = req.body.periodo || 'monthly';   // Recibe "monthly" o "annual"
    const usuarioid = req.user?.usuarioid || req.user?.id || 0;
    
    let tiposuscripcionidReal = 0;
    let precioFinal = 0;
    let nombreExhibicion = "";
    let diasDuracion = 30; // Por defecto 30 días para mensual

    console.log(`📥 Procesando catálogo base -> Plan: "${planOriginal}" | Periodo: "${periodo}"`);

    // 1. Normalizamos los textos del Frontend
    const planNormalizado = typeof planOriginal === 'string' ? planOriginal.toLowerCase().trim() : '';
    const periodoNormalizado = periodo.toLowerCase().trim();

    // 2. Determinamos el ID base (Solo tus 2 suscripciones) y calculamos el precio dinámicamente
    if (planNormalizado === 'premium' || planNormalizado === 'mensual') {
      tiposuscripcionidReal = 1; // ID fijo en tu BD para Premium
      
      if (periodoNormalizado === 'annual' || periodoNormalizado === 'anual') {
        precioFinal = 400.00; // 💰 Precio de Premium Anual (Ejemplo)
        nombreExhibicion = "Plan Premium Anual";
        diasDuracion = 365;
      } else {
        precioFinal = 40.00;  // 💰 Precio de Premium Mensual
        nombreExhibicion = "Plan Premium Mensual";
        diasDuracion = 30;
      }
    } 
    else if (planNormalizado === 'business' || planNormalizado === 'smb') {
      tiposuscripcionidReal = 2; // ID fijo en tu BD para Business
      
      if (periodoNormalizado === 'annual' || periodoNormalizado === 'anual') {
        precioFinal = 1500.00; // 💰 Precio de Business Anual (Ejemplo)
        nombreExhibicion = "Plan Business Anual";
        diasDuracion = 365;
      } else {
        precioFinal = 150.00;  // 💰 Precio de Business Mensual (Ejemplo)
        nombreExhibicion = "Plan Business Mensual";
        diasDuracion = 30;
      }
    } else {
      // Si el frontend envió directamente el número del ID en vez del string
      tiposuscripcionidReal = parseInt(planOriginal, 10);
      // Aquí podrías buscar en la BD el precio base si fuera necesario
    }

    // Validación de seguridad por si no cayó en ningún plan conocido
    if (!tiposuscripcionidReal || precioFinal === 0) {
      return res.status(400).json({ error: "El plan o periodo solicitado no es válido." });
    }

    // 3. Verificamos que el tipo base exista en la base de datos (para traer configuración de límites si tienes)
    const [tipos] = await db.execute(
      "SELECT * FROM tipos_suscripcion WHERE tiposuscripcionid = ? AND activo = 1",
      [tiposuscripcionidReal]
    );

    if (tipos.length === 0) {
      return res.status(404).json({ error: "El plan base no se encuentra activo." });
    }

    console.log(`✅ Todo listo. Cobrando: $${precioFinal} MXN por ${nombreExhibicion}`);

    // 4. Crear la preferencia en Mercado Pago inyectando las variables dinámicas
    const preference = new Preference(client);
    const preferenceData = {
      items: [
        {
          id: tiposuscripcionidReal.toString(),
          title: `Suscripción Renova: ${nombreExhibicion}`, // Le dice al usuario exactamente qué ciclo compra
          quantity: 1,
          unit_price: precioFinal, // 🌟 El precio calculado (Anual o Mensual)
          currency_id: 'MXN'
        }
      ],
      metadata: {
        usuario_id: usuarioid,
        tipo_suscripcion_id: tiposuscripcionidReal,
        periodo: periodoNormalizado, // 🌟 GUARDAMOS EL PERIODO EN METADATOS para leerlo en el Webhook / Success
        dias_duracion: diasDuracion  // Le servirá a tu función de activación para calcular la 'fecha_fin'
      },
      backUrls: { 
        success: "https://tapcards.renova-automatizacion.com?payment=success",
        failure: "https://tapcards.renova-automatizacion.com/precios?payment=error",
        pending: "https://tapcards.renova-automatizacion.com"
      },

      // ✅ SOLUCIÓN: También en camelCase y apuntando a "approved"
      autoReturn: "approved"
    };

    const result = await preference.create({ body: preferenceData });
    return res.json({ id: result.id });

  } catch (error) {
    console.error("❌ ERROR CRÍTICO EN MERCADO PAGO:", error);
    return res.status(500).json({ error: "Error interno al procesar el pago" });
  }
};

  exports.recibirNotificacionPago = async (req, res) => {
      try {
          // 1. Mercado Pago envía el tipo de notificación en los query params o body
          const { query } = req;
          const topic = query.topic || req.body.type;

          // Nos interesa únicamente cuando nos notifican un "payment" (pago)
          if (topic === "payment") {
              const paymentId = query.id || req.body.data.id;
              
              console.log(`📥 Webhook recibido: Consultando pago ID ${paymentId}`);

              // 2. Consultar a Mercado Pago de forma segura para verificar que el pago es real
              const payment = new Payment(mercadopagoClient); // Usa tu cliente configurado
              const paymentData = await payment.get({ id: paymentId });

              // 3. Si el pago fue aprobado exitosamente
              if (paymentData.status === "approved") {
                  
                  // Extraemos los datos que guardamos previamente en la metadata al crear la preferencia
                  const { usuario_id, tipo_suscripcion_id } = paymentData.metadata;
                  
                  // Definimos los días según el plan (puedes mapearlo dinámicamente)
                  const diasSuscripcion = tipo_suscripcion_id === 'premium' ? 30 : 30; 

                  console.log(`🎉 Pago aprobado para el usuario ${usuario_id}. Activando plan ${tipo_suscripcion_id}...`);

                  // 4. Reutilizar la lógica de tu endpoint interno de base de datos
                  // Aquí ejecutas la misma consulta SQL o función que usa tu endpoint '/api/admin/suscripciones/crear'
                  await db.query(
                      `INSERT INTO suscripciones (usuario_id, tiposuscripcionid, dias, renovar_automatico, fecha_inicio, estado) 
                      VALUES (?, ?, ?, ?, NOW(), 'activo')`,
                      [usuario_id, tipo_suscripcion_id, diasSuscripcion, true]
                  );

                  // También actualizas el rol o permisos en la tabla de usuarios si es necesario
                  await db.query('UPDATE usuarios SET rol = "premium" WHERE id = ?', [usuario_id]);
              }
          }

          // Siempre responder un 200 o 200 OK a Mercado Pago para que sepa que recibiste la notificación
          return res.sendStatus(200);

      } catch (error) {
          console.error("❌ Error procesando el Webhook de Mercado Pago:", error);
          // Respondemos 500 para que Mercado Pago intente reenviar la notificación más tarde
          return res.status(500).json({ error: error.message });
      }
  };
