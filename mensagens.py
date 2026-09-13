"""Montagem e envio das credenciais de acesso (professor ou gestor local).

O texto e o mesmo para os dois canais: e-mail (enviado pelo servidor via SMTP)
e WhatsApp (o navegador abre o wa.me com a mensagem pronta).

O que muda entre os perfis e so o rotulo do identificador ("Matricula" para o
professor, "Usuario" para o gestor local) e a quem a pessoa recorre em caso de
duvida — por isso as duas telas usam as mesmas funcoes daqui.
"""

import re
import smtplib
import ssl
from email.message import EmailMessage


class ErroDeEnvio(Exception):
    """Falha ao enviar o e-mail (configuração, autenticação ou conexão)."""


def normalizar_telefone(telefone, ddi_padrao="55"):
    """Deixa o telefone no formato do WhatsApp: só dígitos, com DDI."""
    digitos = re.sub(r"\D", "", str(telefone or ""))
    if not digitos:
        return ""
    if digitos.startswith("00"):
        digitos = digitos[2:]
    # 10 digitos = fixo com DDD, 11 = celular com DDD -> falta o DDI
    if len(digitos) in (10, 11):
        digitos = ddi_padrao + digitos
    return digitos


def montar_texto(nome, escola, endereco, matricula, senha,
                 rotulo="Matrícula", perfil=None, suporte="a coordenação"):
    """Mensagem de credenciais em texto puro.

    `rotulo` e o nome do identificador (Matrícula/Usuário), `perfil` aparece
    como uma linha extra ("Perfil: Gestor Local") e `suporte` diz a quem a
    pessoa recorre em caso de dúvida.
    """
    primeiro_nome = str(nome or "").split(" ")[0]
    linhas = [
        f"Olá, {primeiro_nome}!",
        "",
        f"Seu acesso ao sistema de reserva de laboratórios da {escola} foi criado.",
        "",
    ]
    if perfil:
        linhas.append(f"Perfil: {perfil}")
    linhas += [
        f"{rotulo}: {matricula}",
        f"Senha: {senha}",
    ]
    if endereco:
        linhas += ["", f"Acesse por: {endereco}"]
    linhas += [
        "",
        f"Use {'o usuário' if rotulo.lower().startswith('usu') else 'a matrícula'} "
        "(ou seu e-mail) e a senha acima para entrar.",
        "Guarde esses dados e não compartilhe sua senha.",
        "",
        f"Qualquer dúvida, fale com {suporte}.",
    ]
    return "\n".join(linhas)


def montar_html(nome, escola, endereco, matricula, senha,
                rotulo="Matrícula", perfil=None, suporte="a coordenação"):
    """Versão em HTML da mesma mensagem."""
    primeiro_nome = str(nome or "").split(" ")[0]
    link = (f'<p style="margin:18px 0 0">Acesse por: '
            f'<a href="{endereco}" style="color:#4f46e5">{endereco}</a></p>'
            if endereco else "")
    linha_perfil = (f"""\
    <tr>
      <td style="padding:10px 16px;color:#667085;font-size:13px">Perfil</td>
      <td style="padding:10px 16px;font-weight:700;font-size:16px">{perfil}</td>
    </tr>""" if perfil else "")
    borda = "border-top:1px solid #e4e8f0" if perfil else ""
    return f"""\
<div style="font-family:Segoe UI,Arial,sans-serif;color:#101828;font-size:15px;
            line-height:1.55;max-width:520px">
  <p>Olá, <strong>{primeiro_nome}</strong>!</p>
  <p>Seu acesso ao sistema de reserva de laboratórios da <strong>{escola}</strong>
     foi criado.</p>
  <table style="border-collapse:collapse;background:#f8fafc;border:1px solid #e4e8f0;
                border-radius:10px;padding:6px;margin:18px 0">
    {linha_perfil}
    <tr>
      <td style="padding:10px 16px;color:#667085;font-size:13px;{borda}">{rotulo}</td>
      <td style="padding:10px 16px;font-weight:700;font-size:16px;{borda}">{matricula}</td>
    </tr>
    <tr>
      <td style="padding:10px 16px;color:#667085;font-size:13px;
                 border-top:1px solid #e4e8f0">Senha</td>
      <td style="padding:10px 16px;font-weight:700;font-size:16px;
                 border-top:1px solid #e4e8f0">{senha}</td>
    </tr>
  </table>
  {link}
  <p style="color:#667085;font-size:13px;margin-top:22px">
    Guarde esses dados e não compartilhe sua senha.
    Qualquer dúvida, fale com {suporte}.
  </p>
</div>"""


def link_whatsapp(telefone, texto):
    """URL do WhatsApp com a mensagem pronta (usada pelo navegador)."""
    from urllib.parse import quote

    numero = normalizar_telefone(telefone)
    if not numero:
        return ""
    return f"https://wa.me/{numero}?text={quote(texto)}"


def configuracao_completa(config):
    return bool(config.get("servidor") and config.get("remetente"))


def enviar_email(config, destinatario, assunto, texto, html=None):
    """Envia o e-mail pelo SMTP configurado. Lança ErroDeEnvio em caso de falha."""
    if not configuracao_completa(config):
        raise ErroDeEnvio(
            "O envio por e-mail ainda não foi configurado. "
            "Preencha os dados do servidor SMTP na aba Regras."
        )
    if not destinatario:
        raise ErroDeEnvio("Não há e-mail cadastrado para este destinatário.")

    mensagem = EmailMessage()
    mensagem["Subject"] = assunto
    mensagem["From"] = config["remetente"]
    mensagem["To"] = destinatario
    mensagem.set_content(texto)
    if html:
        mensagem.add_alternative(html, subtype="html")

    porta = int(config.get("porta") or 587)
    contexto = ssl.create_default_context()

    try:
        if porta == 465:
            with smtplib.SMTP_SSL(config["servidor"], porta, context=contexto,
                                  timeout=20) as servidor:
                if config.get("usuario"):
                    servidor.login(config["usuario"], config.get("senha", ""))
                servidor.send_message(mensagem)
        else:
            with smtplib.SMTP(config["servidor"], porta, timeout=20) as servidor:
                servidor.ehlo()
                if config.get("tls", True):
                    servidor.starttls(context=contexto)
                    servidor.ehlo()
                if config.get("usuario"):
                    servidor.login(config["usuario"], config.get("senha", ""))
                servidor.send_message(mensagem)
    except smtplib.SMTPAuthenticationError as erro:
        raise ErroDeEnvio(
            "O servidor recusou o usuário/senha do e-mail. Confira os dados de envio."
        ) from erro
    except (smtplib.SMTPException, OSError) as erro:
        raise ErroDeEnvio(f"Não foi possível enviar o e-mail: {erro}") from erro
