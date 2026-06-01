const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { sendWelcomeEmail, sendLoginNotificationEmail, sendPasswordResetEmail } = require("../utils/email.utils");
const { getMexicoISO } = require("../utils/date.utils");
const { generateTwoFactorCode } = require("../utils/twoFactor.utils");
const { sendTwoFactorCodeEmail } = require("../utils/email2fa.utils");

const getTablasByTipo = (tipo) => {
  if (tipo === 'cliente') {
    return {
      usuarios: 'usuarios_clientes',
      tokens: 'password_reset_tokens_clientes',
      blacklist: 'tokens_blacklist_clientes',
      twoFactor: 'two_factor_auth',
      rolid: 4
    };
  }
  return {
    usuarios: 'usuarios',
    tokens: 'password_reset_tokens',
    blacklist: 'tokens_blacklist',
    twoFactor: 'two_factor_auth',
    rolid: null
  };
};

const verificarYActualizarSuscripcion = async (usuarioid, tipo) => {
  try {
    if (tipo !== 'cliente') {
      return { tiene_suscripcion: true, mensaje: 'Admin no requiere suscripción' };
    }

    const [suscripciones] = await db.execute(
      `SELECT suscripcionid, fecha_fin, estado, automatico_renovar 
       FROM suscripciones_usuarios 
       WHERE usuarioid = ? AND estado = 'activa' 
       LIMIT 1`,
      [usuarioid]
    );

    // Caso 1: No tiene ninguna suscripción registrada
    if (suscripciones.length === 0) {
      console.log(`⚠️ Usuario ID ${usuarioid} no tiene ninguna suscripción activa.`);
      // 🌟 CAMBIO: Devolvemos true en el acceso pero marcando el estado real para que el token se cree
      return { tiene_suscripcion: false, estado: 'ninguna', permitir_login: true };
    }

    const suscripcion = suscripciones[0];
    const ahora = new Date();
    const fechaFin = new Date(suscripcion.fecha_fin);

    // Caso 2: La suscripción sigue vigente
    if (fechaFin > ahora) {
      return { tiene_suscripcion: true, estado: 'activa', permitir_login: true };
    }

    // Caso 3: La fecha ya caducó (VENCIDA)
    console.log(`⏳ La suscripción ID ${suscripcion.suscripcionid} ha expirado. Actualizando estado...`);
    
    // Cambiamos el estado en la base de datos para congelar sus tarjetas
    await db.execute(
      `UPDATE suscripciones_usuarios 
       SET estado = 'cancelada', actualizado = NOW() 
       WHERE suscripcionid = ?`,
      [suscripcion.suscripcionid]
    );

    // Guardamos el movimiento en el historial de forma segura
    try {
      await db.execute(
        `INSERT INTO historial_suscripciones 
         (suscripcionid, usuarioid, tipo_usuario, motivo, estado_anterior, estado_nuevo)
         VALUES (?, ?, 'cliente', 'Expiración automática por sistema', 'activa', 'cancelada')`,
        [suscripcion.suscripcionid, usuarioid]
      );
    } catch (errHistorial) {
      console.warn("⚠️ No se pudo duplicar registro en historial, ignorando...");
    }

    // 🌟 ¡AQUÍ ESTÁ EL TRUCO DE LA LIBERACIÓN! 
    // En lugar de lanzar un error que rompa el login, avisamos que ya no es activa pero PERMITIMOS ingresar.
    return { 
      tiene_suscripcion: false, 
      estado: 'cancelada', 
      permitir_login: true, // 🔓 Le da luz verde al controlador de Login
      mensaje: 'Tu suscripción ha vencido. Acceso al dashboard permitido en modo de lectura/renovación.' 
    };

  } catch (error) {
    console.error("❌ Error en verificarYActualizarSuscripcion:", error);
    // Ante cualquier duda o caída, es mejor dejar pasar al usuario que bloquearlo por completo
    return { tiene_suscripcion: false, permitir_login: true };
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password, ip_ultimo_login, tipo = 'admin', two_factor_code, backup_code } = req.body;
    const tablas = getTablasByTipo(tipo);
    const twoFactorTable = 'two_factor_auth';

    if (!email || !password) {
      return res.status(400).json({
        error: "Email y password son requeridos"
      });
    }

    const [rows] = await db.execute(
      `SELECT * FROM ${tablas.usuarios} WHERE email = ? AND activo = 1 LIMIT 1`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: "Usuario o contraseña incorrectos"
      });
    }

    const user = rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({
        error: "Usuario o contraseña incorrectos"
      });
    }

    if (tipo === 'cliente') {
      const verificacion = await verificarYActualizarSuscripcion(user.usuarioid, tipo);
      //
      //if (!verificacion.tiene_suscripcion) {
        //return res.status(403).json({
         // error: "Acceso denegado",
        //  requires_subscription: true,
      //    subscription_expired: true,
      //    message: verificacion.mensaje,
      //    fecha_vencimiento: verificacion.fecha_vencimiento,
      //    necesita_renovar: true
      //  });
     // }
      ///
      user.suscripcion_info = {
        dias_restantes: verificacion.dias_restantes,
        fecha_vencimiento: verificacion.fecha_vencimiento
      };
    }

    if (user.two_factor_enabled === 1) {
      if (!two_factor_code && !backup_code) {
        const codigo = generateTwoFactorCode();
        const expiracion = new Date();
        expiracion.setMinutes(expiracion.getMinutes() + 10);

        await db.execute(
          `DELETE FROM ${twoFactorTable} WHERE usuarioid = ? AND tipo_usuario = ? AND usado = 0 AND LENGTH(codigo) = 6`,
          [user.usuarioid, tipo]
        );

        await db.execute(
          `INSERT INTO ${twoFactorTable} (usuarioid, tipo_usuario, codigo, expiracion, usado) VALUES (?, ?, ?, ?, 0)`,
          [user.usuarioid, tipo, codigo, expiracion]
        );

        try {
          await sendTwoFactorCodeEmail(user.email, user.nombre, codigo);
          console.log('Código 2FA enviado a:', user.email);
        } catch (emailError) {
          console.error("Error enviando código 2FA:", emailError);
        }

        return res.status(403).json({
          error: "Se requiere código de verificación",
          requires_two_factor: true,
          two_factor_enabled: true,
          two_factor_verified: false,
          message: "Se ha enviado un código de verificación a tu correo electrónico"
        });
      }

      const isBackup = !!backup_code;
      const codigoIngresado = two_factor_code || backup_code;
      let isValid = false;

      if (isBackup) {
        const [codes] = await db.execute(
          `SELECT id, codigo, usado FROM ${twoFactorTable} WHERE usuarioid = ? AND tipo_usuario = ? AND usado = 0 AND LENGTH(codigo) > 6`,
          [user.usuarioid, tipo]
        );

        for (const code of codes) {
          const match = await bcrypt.compare(codigoIngresado, code.codigo);
          if (match) {
            isValid = true;
            await db.execute(`UPDATE ${twoFactorTable} SET usado = 1 WHERE id = ?`, [code.id]);
            break;
          }
        }

        if (!isValid) {
          return res.status(401).json({ error: "Código de respaldo inválido o ya utilizado" });
        }
      } else {
        if (!/^\d{6}$/.test(codigoIngresado)) {
          return res.status(400).json({ error: "Código inválido. Debe ser de 6 dígitos." });
        }

        const [codes] = await db.execute(
          `SELECT id, codigo, expiracion, usado, intentos FROM ${twoFactorTable} 
           WHERE usuarioid = ? AND tipo_usuario = ? AND usado = 0 AND codigo = ? 
           ORDER BY id DESC LIMIT 1`,
          [user.usuarioid, tipo, codigoIngresado]
        );

        if (codes.length === 0) {
          return res.status(401).json({ error: "Código inválido" });
        }

        const record = codes[0];

        if (new Date() > new Date(record.expiracion)) {
          await db.execute(`UPDATE ${twoFactorTable} SET usado = 1 WHERE id = ?`, [record.id]);
          return res.status(401).json({ error: "El código ha expirado. Solicita uno nuevo." });
        }

        if (record.intentos >= 5) {
          await db.execute(`UPDATE ${twoFactorTable} SET usado = 1 WHERE id = ?`, [record.id]);
          return res.status(401).json({ error: "Demasiados intentos. Solicita un nuevo código." });
        }

        await db.execute(`UPDATE ${twoFactorTable} SET intentos = intentos + 1 WHERE id = ?`, [record.id]);
        isValid = true;
      }

      if (!isValid) {
        return res.status(401).json({ error: "Código de verificación inválido" });
      }

      await db.execute(
        `UPDATE ${tablas.usuarios} SET two_factor_verified = 1 WHERE usuarioid = ?`,
        [user.usuarioid]
      );

      await db.execute(
        `UPDATE ${twoFactorTable} SET usado = 1 WHERE usuarioid = ? AND tipo_usuario = ? AND LENGTH(codigo) = 6 AND usado = 0`,
        [user.usuarioid, tipo]
      );
    }

    const ultimo_login = getMexicoISO();

    await db.execute(
      `UPDATE ${tablas.usuarios} 
       SET ultimo_login = ?, ip_ultimo_login = ?
       WHERE usuarioid = ?`,
      [ultimo_login, ip_ultimo_login, user.usuarioid]
    );

    const token = jwt.sign(
      {
        usuarioid: user.usuarioid,
        email: user.email,
        rolid: user.rolid,
        tipo: tipo,
        twoFactorVerified: user.two_factor_enabled === 1
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN
      }
    );

    delete user.password;

    let infoAdicional = {};
    if (tipo === 'cliente') {
      const [clienteInfo] = await db.execute(
        "SELECT * FROM clientes WHERE usuarioid = ?",
        [user.usuarioid]
      );
      if (clienteInfo.length > 0) {
        infoAdicional = clienteInfo[0];
      }
    }

    try {
      await sendLoginNotificationEmail(user.email, user.nombre, ip_ultimo_login, tipo);
    } catch (emailError) {
      console.error("Error al enviar notificación de login:", emailError);
    }

    return res.json({
      token,
      usuario: {
        ...user,
        ultimo_login,
        ip_ultimo_login,
        tipo
      },
      two_factor_enabled: user.two_factor_enabled === 1,
      two_factor_verified: true,
      ...(tipo === 'cliente' && { cliente: infoAdicional }),
      suscripcion: tipo === 'cliente' ? user.suscripcion_info : null
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error en login"
    });
  }
};

exports.registerCliente = async (req, res) => {
  try {
    const { 
      nombre, email, password, ip_registro,
      telefono, telefono_alternativo, fecha_nacimiento, genero,
      calle, numero_exterior, numero_interior, colonia,
      ciudad, estado, pais, codigo_postal, referencias,
      razon_social, rfc, regimen_fiscal, cfdi_uso, email_facturacion,
      notas
    } = req.body;

    if (!nombre || !email || !password) {
      return res.status(400).json({
        error: "Nombre, email y password son requeridos"
      });
    }

    const [existingAdmin] = await db.execute(
      "SELECT usuarioid FROM usuarios WHERE email = ? LIMIT 1",
      [email]
    );
    const [existingCliente] = await db.execute(
      "SELECT usuarioid FROM usuarios_clientes WHERE email = ? LIMIT 1",
      [email]
    );

    if (existingAdmin.length > 0 || existingCliente.length > 0) {
      return res.status(400).json({
        error: "El email ya está registrado"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "La contraseña debe tener al menos 6 caracteres"
      });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const fecha_creacion = getMexicoISO();

    const [result] = await db.execute(
      `INSERT INTO usuarios_clientes 
       (nombre, email, password, rolid, activo, creado, ip_ultimo_login, two_factor_enabled, two_factor_verified) 
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [nombre, email, hashedPassword, 4, 1, fecha_creacion, ip_registro || null]
    );

    const usuarioid = result.insertId;

    await db.execute(
      `INSERT INTO clientes 
       (usuarioid, telefono, telefono_alternativo, fecha_nacimiento, genero,
        calle, numero_exterior, numero_interior, colonia, ciudad, estado, pais,
        codigo_postal, referencias, razon_social, rfc, regimen_fiscal, cfdi_uso,
        email_facturacion, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        usuarioid, telefono || null, telefono_alternativo || null, 
        fecha_nacimiento || null, genero || null,
        calle || null, numero_exterior || null, numero_interior || null,
        colonia || null, ciudad || null, estado || null, pais || 'México',
        codigo_postal || null, referencias || null, razon_social || null,
        rfc || null, regimen_fiscal || null, cfdi_uso || null,
        email_facturacion || null, notas || null
      ]
    );

    const token = jwt.sign(
      {
        usuarioid: usuarioid,
        email: email,
        rolid: 4,
        tipo: 'cliente',
        twoFactorVerified: false
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN
      }
    );

    try {
      await sendWelcomeEmail(email, nombre, 'cliente');
    } catch (emailError) {
      console.error("Error al enviar correo de bienvenida:", emailError);
    }

    return res.status(201).json({
      message: "Cliente registrado exitosamente",
      token,
      usuario: {
        usuarioid,
        nombre,
        email,
        rolid: 4,
        activo: 1,
        creado: fecha_creacion,
        tipo: 'cliente',
        two_factor_enabled: 0,
        two_factor_verified: 0
      }
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error en el registro de cliente"
    });
  }
};

exports.register = async (req, res) => {
  try {
    const { nombre, email, password, ip_registro } = req.body;

    if (!nombre || !email || !password) {
      return res.status(400).json({
        error: "Nombre, email y password son requeridos"
      });
    }

    const [existingAdmin] = await db.execute(
      "SELECT usuarioid FROM usuarios WHERE email = ? LIMIT 1",
      [email]
    );
    const [existingCliente] = await db.execute(
      "SELECT usuarioid FROM usuarios_clientes WHERE email = ? LIMIT 1",
      [email]
    );

    if (existingAdmin.length > 0 || existingCliente.length > 0) {
      return res.status(400).json({
        error: "El email ya está registrado"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "La contraseña debe tener al menos 6 caracteres"
      });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const fecha_creacion = getMexicoISO();

    const [result] = await db.execute(
      `INSERT INTO usuarios 
       (nombre, email, password, rolid, activo, creado, ip_ultimo_login, two_factor_enabled, two_factor_verified) 
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [nombre, email, hashedPassword, 3, 1, fecha_creacion, ip_registro || null]
    );

    const token = jwt.sign(
      {
        usuarioid: result.insertId,
        email: email,
        rolid: 3,
        tipo: 'admin',
        twoFactorVerified: false
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN
      }
    );

    try {
      await sendWelcomeEmail(email, nombre, 'admin');
    } catch (emailError) {
      console.error("Error al enviar correo de bienvenida:", emailError);
    }

    return res.status(201).json({
      message: "Usuario registrado exitosamente",
      token,
      usuario: {
        usuarioid: result.insertId,
        nombre,
        email,
        rolid: 3,
        activo: 1,
        creado: fecha_creacion,
        tipo: 'admin',
        two_factor_enabled: 0,
        two_factor_verified: 0
      }
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error en el registro de usuario"
    });
  }
};

exports.logout = async (req, res) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    const tipo = req.user?.tipo || 'admin';
    const tablas = getTablasByTipo(tipo);

    if (req.user?.usuarioid) {
      await db.execute(
        `UPDATE ${tablas.usuarios} SET two_factor_verified = 0 WHERE usuarioid = ?`,
        [req.user.usuarioid]
      );
      console.log(`[LOGOUT] two_factor_verified reset para usuario ${req.user.usuarioid}`);
    }

    if (!token) {
      return res.status(400).json({
        error: "Token no proporcionado"
      });
    }

    const decoded = jwt.decode(token);
    
    if (decoded && decoded.exp) {
      const fecha_expiracion = new Date(decoded.exp * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");

      await db.execute(
        `INSERT INTO ${tablas.blacklist} (token, fecha_expiracion) VALUES (?, ?)`,
        [token, fecha_expiracion]
      );
    }

    return res.json({
      message: "Sesión cerrada exitosamente"
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error al cerrar sesión"
    });
  }
};

exports.getProfile = async (req, res) => {
  try {
    const usuarioid = req.user.usuarioid;
    const tipo = req.user.tipo;
    const tablas = getTablasByTipo(tipo);

    let query;
    if (tipo === 'cliente') {
      query = `
        SELECT u.usuarioid, u.nombre, u.email, u.activo, u.creado, 
               u.ultimo_login, u.ip_ultimo_login, u.rolid, u.two_factor_enabled, u.two_factor_verified,
               c.*
        FROM ${tablas.usuarios} u
        LEFT JOIN clientes c ON u.usuarioid = c.usuarioid
        WHERE u.usuarioid = ? AND u.activo = 1
      `;
    } else {
      query = `
        SELECT u.usuarioid, u.nombre, u.email, u.activo, u.creado, 
               u.ultimo_login, u.ip_ultimo_login, u.rolid, u.two_factor_enabled, u.two_factor_verified,
               r.nombre as rol_nombre
        FROM ${tablas.usuarios} u
        LEFT JOIN roles r ON u.rolid = r.rolid
        WHERE u.usuarioid = ? AND u.activo = 1
      `;
    }

    const [rows] = await db.execute(query, [usuarioid]);

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Usuario no encontrado"
      });
    }

    return res.json({
      usuario: rows[0],
      tipo
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error al obtener perfil"
    });
  }
};

exports.updateClienteProfile = async (req, res) => {
  try {
    const usuarioid = req.user.usuarioid;
    const {
      telefono, telefono_alternativo, fecha_nacimiento, genero,
      calle, numero_exterior, numero_interior, colonia,
      ciudad, estado, pais, codigo_postal, referencias,
      razon_social, rfc, regimen_fiscal, cfdi_uso, email_facturacion,
      notas
    } = req.body;

    await db.execute(
      `UPDATE clientes 
       SET telefono = ?, telefono_alternativo = ?, fecha_nacimiento = ?, genero = ?,
           calle = ?, numero_exterior = ?, numero_interior = ?, colonia = ?,
           ciudad = ?, estado = ?, pais = ?, codigo_postal = ?, referencias = ?,
           razon_social = ?, rfc = ?, regimen_fiscal = ?, cfdi_uso = ?,
           email_facturacion = ?, notas = ?
       WHERE usuarioid = ?`,
      [
        telefono || null, telefono_alternativo || null, 
        fecha_nacimiento || null, genero || null,
        calle || null, numero_exterior || null, numero_interior || null,
        colonia || null, ciudad || null, estado || null, pais || 'México',
        codigo_postal || null, referencias || null, razon_social || null,
        rfc || null, regimen_fiscal || null, cfdi_uso || null,
        email_facturacion || null, notas || null, usuarioid
      ]
    );

    return res.json({
      message: "Perfil de cliente actualizado exitosamente"
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error al actualizar perfil de cliente"
    });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { password_actual, password_nuevo } = req.body;
    const usuarioid = req.user.usuarioid;
    const tipo = req.user.tipo;
    const tablas = getTablasByTipo(tipo);

    if (!password_actual || !password_nuevo) {
      return res.status(400).json({
        error: "Contraseña actual y nueva son requeridas"
      });
    }

    if (password_nuevo.length < 6) {
      return res.status(400).json({
        error: "La nueva contraseña debe tener al menos 6 caracteres"
      });
    }

    const [rows] = await db.execute(
      `SELECT password FROM ${tablas.usuarios} WHERE usuarioid = ? AND activo = 1`,
      [usuarioid]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Usuario no encontrado"
      });
    }

    const user = rows[0];
    const passwordMatch = await bcrypt.compare(password_actual, user.password);

    if (!passwordMatch) {
      return res.status(401).json({
        error: "Contraseña actual incorrecta"
      });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password_nuevo, saltRounds);

    await db.execute(
      `UPDATE ${tablas.usuarios} SET password = ? WHERE usuarioid = ?`,
      [hashedPassword, usuarioid]
    );

    return res.json({
      message: "Contraseña actualizada exitosamente"
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error al cambiar contraseña"
    });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email, tipo = 'admin' } = req.body;
    const tablas = getTablasByTipo(tipo);

    if (!email) {
      return res.status(400).json({
        error: "Email es requerido"
      });
    }

    const [users] = await db.execute(
      `SELECT usuarioid, nombre, email FROM ${tablas.usuarios} WHERE email = ? AND activo = 1`,
      [email]
    );

    if (users.length === 0) {
      return res.json({
        message: "Si el email existe, recibirás instrucciones para recuperar tu contraseña"
      });
    }

    const user = users[0];
    const resetToken = crypto.randomBytes(32).toString("hex");
    
    const expiracion = new Date();
    expiracion.setHours(expiracion.getHours() + 1);
    const expiracionStr = expiracion.toISOString().slice(0, 19).replace("T", " ");

    await db.execute(`
      CREATE TABLE IF NOT EXISTS ${tablas.tokens} (
        id int NOT NULL AUTO_INCREMENT,
        usuarioid int NOT NULL,
        token varchar(255) NOT NULL,
        expiracion timestamp NOT NULL,
        usado tinyint(1) DEFAULT '0',
        creado timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY token_unique (token),
        KEY usuarioid (usuarioid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(
      `INSERT INTO ${tablas.tokens} (usuarioid, token, expiracion) VALUES (?, ?, ?)`,
      [user.usuarioid, resetToken, expiracionStr]
    );

    try {
      await sendPasswordResetEmail(user.email, user.nombre, resetToken, tipo);
    } catch (emailError) {
      console.error("Error al enviar email:", emailError);
    }

    return res.json({
      message: "Si el email existe, recibirás instrucciones para recuperar tu contraseña"
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error en recuperación de contraseña"
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token, new_password, tipo = 'admin' } = req.body;
    const tablas = getTablasByTipo(tipo);

    if (!token || !new_password) {
      return res.status(400).json({
        error: "Token y nueva contraseña son requeridos"
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        error: "La contraseña debe tener al menos 6 caracteres"
      });
    }

    const [tokens] = await db.execute(
      `SELECT * FROM ${tablas.tokens} 
       WHERE token = ? AND usado = 0 AND expiracion > NOW() 
       LIMIT 1`,
      [token]
    );

    if (tokens.length === 0) {
      return res.status(400).json({
        error: "Token inválido o expirado"
      });
    }

    const resetToken = tokens[0];
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(new_password, saltRounds);

    await db.execute(
      `UPDATE ${tablas.usuarios} SET password = ? WHERE usuarioid = ?`,
      [hashedPassword, resetToken.usuarioid]
    );

    await db.execute(
      `UPDATE ${tablas.tokens} SET usado = 1 WHERE id = ?`,
      [resetToken.id]
    );

    await db.execute(
      `UPDATE ${tablas.tokens} SET usado = 1 WHERE usuarioid = ? AND id != ?`,
      [resetToken.usuarioid, resetToken.id]
    );

    return res.json({
      message: "Contraseña actualizada exitosamente"
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error al restablecer contraseña"
    });
  }
};